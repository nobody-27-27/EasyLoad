// src/core/solvers/coil-solver/horizontal-stacker.ts

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  PlacementCandidate,
  CoilSolverConfig,
  CylinderLayer,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';

/**
 * HorizontalStacker handles the placement of cylinders in horizontal (lying) orientation.
 * Think of logs stacked in a pile - this is "honeycomb/hexagonal" packing strategy.
 *
 * Strategy:
 * 1. Place first row of cylinders on the floor along X-axis
 * 2. Second row nestles in the valleys between first row cylinders
 * 3. Continue alternating pattern up to container height
 * 4. When XZ cross-section is full, advance along Y-axis
 *
 * Physical Model:
 * - Cylinders lie horizontally (axis along Y/depth)
 * - Each cylinder's circular cross-section is in the XZ plane
 * - Stacking layers rise along the Z axis
 * - The honeycomb pattern emerges from circles nesting in valleys
 */
export class HorizontalStacker {
  private container: Container;
  private config: CoilSolverConfig;
  private placedCylinders: PlacedCylinder[] = [];
  private layers: CylinderLayer[] = [];

  constructor(container: Container, config: CoilSolverConfig) {
    this.container = container;
    this.config = config;
  }

  /**
   * Solve horizontal stacking for a set of items
   * Returns placed cylinders and items that couldn't be placed
   */
  public solve(items: CargoItem[]): {
    placed: PlacedCylinder[];
    unplaced: CargoItem[];
  } {
    this.placedCylinders = [];
    this.layers = [];

    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    // Sort items by diameter (largest first) for better packing
    // Then by length (longest first) to group similar lengths
    const sortedItems = [...items].sort((a, b) => {
      const diamDiff = b.dimensions.width - a.dimensions.width;
      if (Math.abs(diamDiff) > 1) return diamDiff;
      return b.dimensions.height - a.dimensions.height;
    });

    // Flatten quantity into individual items
    const queue: CargoItem[] = [];
    for (const item of sortedItems) {
      for (let i = 0; i < item.quantity; i++) {
        queue.push({ ...item, quantity: 1 });
      }
    }

    // Place each item
    for (const item of queue) {
      const placement = this.findBestPlacement(item);

      if (placement) {
        const cylinder = this.createPlacedCylinder(item, placement);
        placed.push(cylinder);
        this.placedCylinders.push(cylinder);
        this.updateLayers(cylinder);
      } else {
        unplaced.push(item);
      }
    }

    return { placed, unplaced };
  }

  /**
   * Find the best placement for a single item using systematic search
   */
  private findBestPlacement(item: CargoItem): PlacementCandidate | null {
    const radius = item.dimensions.width / 2;
    const length = item.dimensions.height;
    const diameter = radius * 2;
    const margin = this.config.wallMargin;

    // Generate all possible honeycomb positions systematically
    const candidates: PlacementCandidate[] = [];

    // Honeycomb row parameters
    const rowHeight = radius * Math.sqrt(3); // Vertical spacing between honeycomb rows

    // Scan through Y-slices (depth)
    const yStep = length; // Each Y-slice is one cylinder length

    for (let yStart = margin; yStart + length <= this.container.dimensions.length - margin; yStart += yStep) {
      // For each Y-slice, generate honeycomb positions in XZ plane
      let row = 0;
      let z = 0; // Base Z for this row

      while (z + diameter <= this.container.dimensions.height) {
        const isOddRow = row % 2 === 1;
        const xOffset = isOddRow ? radius : 0; // Honeycomb offset for odd rows

        // Scan across width (X-axis)
        let x = margin + radius + xOffset;

        while (x + radius <= this.container.dimensions.width - margin) {
          const centerX = x;
          const centerY = yStart + length / 2;
          const cornerZ = z;

          // Check if position is valid (no collision)
          if (!this.hasCollisionAt(centerX, centerY, cornerZ, radius, length)) {
            const cornerPos = {
              x: centerX - radius,
              y: yStart,
              z: cornerZ,
            };
            const centerPos = {
              x: centerX,
              y: centerY,
              z: cornerZ,
            };

            const score = this.calculateScore(cornerPos);
            candidates.push({
              position: cornerPos,
              center: centerPos,
              orientation: 'horizontal-y',
              score,
              supportType: row === 0 ? 'floor' : 'nested',
              supportingIds: [],
            });
          }

          x += diameter; // Move to next X position
        }

        // Move to next honeycomb row
        row++;
        z += rowHeight;
      }
    }

    // Sort by score (lower is better) and return best
    candidates.sort((a, b) => a.score - b.score);
    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * Check if placing a cylinder would cause collision
   */
  private hasCollisionAt(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number
  ): boolean {
    const margin = this.config.cylinderMargin;

    for (const placed of this.placedCylinders) {
      if (this.cylindersOverlap(cx, cy, cz, radius, length, placed, margin)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check overlap between new cylinder and placed cylinder
   * Uses precise circular geometry for same-orientation cylinders
   */
  private cylindersOverlap(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number,
    placed: PlacedCylinder,
    margin: number
  ): boolean {
    // For horizontal-y cylinders, check Y range overlap first
    const y1Min = cy - length / 2;
    const y1Max = cy + length / 2;
    const y2Min = placed.position.y;
    const y2Max = placed.position.y + placed.length;

    // No Y overlap means no collision
    if (y1Max <= y2Min + margin || y1Min >= y2Max - margin) {
      return false;
    }

    // Check XZ circle overlap (cross-section view)
    if (placed.orientation === 'horizontal-y') {
      // Circle centers in XZ plane
      const c1x = cx;
      const c1z = cz + radius; // Center of circle
      const c2x = placed.center.x;
      const c2z = placed.center.z + placed.radius;

      const dist = Math.sqrt(
        Math.pow(c1x - c2x, 2) + Math.pow(c1z - c2z, 2)
      );
      return dist < radius + placed.radius - margin;
    }

    // For mixed orientations, use AABB
    const diameter = radius * 2;
    const x1Min = cx - radius;
    const x1Max = cx + radius;
    const z1Min = cz;
    const z1Max = cz + diameter;

    const x2Min = placed.position.x;
    const x2Max = placed.position.x + placed.radius * 2;
    const z2Min = placed.position.z;
    const z2Max = placed.position.z + placed.radius * 2;

    const noOverlap =
      x1Max <= x2Min + margin ||
      x1Min >= x2Max - margin ||
      z1Max <= z2Min + margin ||
      z1Min >= z2Max - margin;

    return !noOverlap;
  }

  /**
   * Create a PlacedCylinder from an item and placement
   */
  private createPlacedCylinder(item: CargoItem, placement: PlacementCandidate): PlacedCylinder {
    const radius = item.dimensions.width / 2;
    const length = item.dimensions.height;

    return {
      item,
      uniqueId: `${item.id}_h_${Math.random().toString(36).substr(2, 6)}`,
      position: placement.position,
      center: placement.center,
      radius,
      length,
      orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'],
      layerId: this.getLayerIdForZ(placement.position.z),
      supportedBy: placement.supportingIds,
    };
  }

  /**
   * Update layer tracking
   */
  private updateLayers(cylinder: PlacedCylinder): void {
    const layerId = cylinder.layerId;
    let layer = this.layers.find((l) => l.id === layerId);

    if (!layer) {
      layer = {
        id: layerId,
        baseZ: cylinder.position.z,
        height: cylinder.radius * 2,
        orientation: 'horizontal-y',
        cylinders: [],
      };
      this.layers.push(layer);
      this.layers.sort((a, b) => a.baseZ - b.baseZ);
    }

    layer.cylinders.push(cylinder);
  }

  /**
   * Get or create layer ID for a Z position
   */
  private getLayerIdForZ(z: number): number {
    for (const layer of this.layers) {
      if (Math.abs(layer.baseZ - z) < 5) {
        return layer.id;
      }
    }
    return this.layers.length;
  }

  /**
   * Calculate placement score (lower is better)
   * Prioritizes: fill Y first (back of container) -> Z (bottom) -> X (left)
   */
  private calculateScore(position: { x: number; y: number; z: number }): number {
    return (
      position.y * this.config.depthWeight +
      position.z * this.config.heightWeight +
      position.x * this.config.widthWeight
    );
  }

  /**
   * Calculate volume efficiency for current placement
   */
  public calculateEfficiency(): number {
    if (this.placedCylinders.length === 0) return 0;

    let totalCylinderVolume = 0;
    let maxX = 0, maxY = 0, maxZ = 0;

    for (const cyl of this.placedCylinders) {
      totalCylinderVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;

      maxX = Math.max(maxX, cyl.position.x + cyl.radius * 2);
      maxY = Math.max(maxY, cyl.position.y + cyl.length);
      maxZ = Math.max(maxZ, cyl.position.z + cyl.radius * 2);
    }

    const boundingVolume = maxX * maxY * maxZ;
    return boundingVolume > 0 ? totalCylinderVolume / boundingVolume : 0;
  }

  /**
   * Get placed cylinders
   */
  public getPlacedCylinders(): PlacedCylinder[] {
    return [...this.placedCylinders];
  }

  /**
   * Get layers
   */
  public getLayers(): CylinderLayer[] {
    return [...this.layers];
  }
}
