// src/core/solvers/coil-solver/horizontal-stacker.ts

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  PlacementCandidate,
  CoilSolverConfig,
  CylinderLayer,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';
import { ValleyManager } from './valley-manager';
import { CylinderGeometry, type Circle2D } from '../../math/cylinder-math/cylinder-geometry';

/**
 * HorizontalStacker handles the placement of cylinders in horizontal (lying) orientation.
 * Think of logs stacked in a pile - this is "honeycomb/hexagonal" packing strategy.
 *
 * Strategy:
 * 1. Place first row of cylinders on the floor, touching each other
 * 2. Second row nestles in the valleys between first row cylinders
 * 3. Continue alternating pattern up to container height
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
  private valleyManager: ValleyManager;
  private layers: CylinderLayer[] = [];

  // Track XZ positions for honeycomb calculation
  private xzCircles: Map<number, Circle2D[]> = new Map(); // layerId -> circles

  constructor(container: Container, config: CoilSolverConfig) {
    this.container = container;
    this.config = config;
    this.valleyManager = new ValleyManager(container, config);
  }

  /**
   * Solve horizontal stacking for a set of items
   * Returns placed cylinders and items that couldn't be placed
   */
  public solve(items: CargoItem[]): {
    placed: PlacedCylinder[];
    unplaced: CargoItem[];
  } {
    this.valleyManager.clear();
    this.layers = [];
    this.xzCircles.clear();

    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    // Sort items by volume (largest first) - Best Fit Decreasing
    const sortedItems = [...items].sort((a, b) => {
      const volA = Math.PI * Math.pow(a.dimensions.width / 2, 2) * a.dimensions.height;
      const volB = Math.PI * Math.pow(b.dimensions.width / 2, 2) * b.dimensions.height;
      return volB - volA;
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
        this.valleyManager.addCylinder(cylinder);
        this.updateLayers(cylinder);
        this.updateXZCircles(cylinder);
      } else {
        unplaced.push(item);
      }
    }

    return { placed, unplaced };
  }

  /**
   * Find the best placement for a single item
   */
  private findBestPlacement(item: CargoItem): PlacementCandidate | null {
    const radius = item.dimensions.width / 2;
    const length = item.dimensions.height;

    // Collect all candidate positions
    const candidates: PlacementCandidate[] = [];

    // 1. Try floor positions first
    const floorCandidates = this.findFloorPositions(radius, length);
    candidates.push(...floorCandidates);

    // 2. Try honeycomb nesting positions (valleys in XZ plane)
    const honeycombCandidates = this.findHoneycombPositions(radius, length);
    candidates.push(...honeycombCandidates);

    // 3. Try stacking directly on top
    if (item.stackable) {
      const stackingCandidates = this.valleyManager.findStackingPositions(
        radius,
        length,
        'horizontal-y'
      );
      candidates.push(...stackingCandidates);
    }

    // Sort by score and return best
    candidates.sort((a, b) => a.score - b.score);
    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * Find floor positions for horizontal cylinders
   * Uses tight packing along X axis
   */
  private findFloorPositions(radius: number, length: number): PlacementCandidate[] {
    const candidates: PlacementCandidate[] = [];
    const diameter = radius * 2;
    const margin = this.config.wallMargin;

    // For horizontal-Y orientation: cylinder runs along Y axis
    // XZ plane is the cross-section

    // Find existing floor cylinders to pack against
    const floorCylinders = this.valleyManager.getPlacedCylinders().filter(
      (c) => c.orientation === 'horizontal-y' && c.position.z < diameter
    );

    if (floorCylinders.length === 0) {
      // First cylinder: place at the start
      const x = margin + radius;
      const y = margin;
      const z = 0;

      if (
        x + radius <= this.container.dimensions.width - margin &&
        y + length <= this.container.dimensions.length - margin &&
        z + diameter <= this.container.dimensions.height
      ) {
        const cornerPos = { x: x - radius, y, z };
        const centerPos = { x, y: y + length / 2, z };

        candidates.push({
          position: cornerPos,
          center: centerPos,
          orientation: 'horizontal-y',
          score: this.calculateScore(cornerPos),
          supportType: 'floor',
          supportingIds: [],
        });
      }
    } else {
      // Pack next to existing floor cylinders
      // Find the rightmost floor cylinder
      let maxX = margin;
      for (const cyl of floorCylinders) {
        const cylMaxX = cyl.center.x + cyl.radius;
        if (cylMaxX > maxX) {
          maxX = cylMaxX;
        }
      }

      // Place next to it
      const x = maxX + radius + this.config.cylinderMargin;
      const y = margin;
      const z = 0;

      if (
        x + radius <= this.container.dimensions.width - margin &&
        y + length <= this.container.dimensions.length - margin &&
        z + diameter <= this.container.dimensions.height
      ) {
        // Check collision
        if (!this.hasCollisionAt(x, y + length / 2, z, radius, length)) {
          const cornerPos = { x: x - radius, y, z };
          const centerPos = { x, y: y + length / 2, z };

          candidates.push({
            position: cornerPos,
            center: centerPos,
            orientation: 'horizontal-y',
            score: this.calculateScore(cornerPos),
            supportType: 'floor',
            supportingIds: [],
          });
        }
      }
    }

    return candidates;
  }

  /**
   * Find honeycomb positions by looking at XZ plane cross-sections
   * This is where the magic happens - finding valleys between cylinders
   */
  private findHoneycombPositions(radius: number, length: number): PlacementCandidate[] {
    const candidates: PlacementCandidate[] = [];
    const margin = this.config.wallMargin;
    const diameter = radius * 2;

    // Get all horizontal cylinders
    const horizontalCylinders = this.valleyManager.getPlacedCylinders().filter(
      (c) => c.orientation === 'horizontal-y'
    );

    if (horizontalCylinders.length < 2) {
      return candidates;
    }

    // Group cylinders by their Y range overlap potential
    // We need cylinders that overlap in Y to form a valid valley

    // For each pair of cylinders, check if they can support a new one
    for (let i = 0; i < horizontalCylinders.length; i++) {
      for (let j = i + 1; j < horizontalCylinders.length; j++) {
        const cyl1 = horizontalCylinders[i];
        const cyl2 = horizontalCylinders[j];

        // Check Y overlap
        const y1Min = cyl1.position.y;
        const y1Max = cyl1.position.y + cyl1.length;
        const y2Min = cyl2.position.y;
        const y2Max = cyl2.position.y + cyl2.length;

        const overlapMin = Math.max(y1Min, y2Min);
        const overlapMax = Math.min(y1Max, y2Max);

        // Need enough overlap for the new cylinder
        if (overlapMax - overlapMin < length - this.config.cylinderMargin) {
          continue;
        }

        // Get XZ circles
        const circle1: Circle2D = {
          x: cyl1.center.x,
          z: cyl1.center.z + cyl1.radius, // Center of circle in XZ
          radius: cyl1.radius,
        };

        const circle2: Circle2D = {
          x: cyl2.center.x,
          z: cyl2.center.z + cyl2.radius,
          radius: cyl2.radius,
        };

        // Check height compatibility (circles should be at similar Z)
        const zDiff = Math.abs(circle1.z - circle2.z);
        if (zDiff > (cyl1.radius + cyl2.radius) * 1.2) {
          continue;
        }

        // Calculate nest position
        const nestPos = CylinderGeometry.calculateNestPosition(circle1, circle2, radius);
        if (!nestPos) {
          continue;
        }

        // The nestPos.z is the center of the new circle in XZ plane
        // The actual Z position of the cylinder bottom is nestPos.z - radius
        const newZ = nestPos.z - radius;

        // Validate bounds
        if (nestPos.x - radius < margin) continue;
        if (nestPos.x + radius > this.container.dimensions.width - margin) continue;
        if (newZ < 0) continue;
        if (newZ + diameter > this.container.dimensions.height) continue;

        // Y position: center of overlap
        const yPos = (overlapMin + overlapMax) / 2;

        // Check collision
        if (this.hasCollisionAt(nestPos.x, yPos, newZ, radius, length)) {
          continue;
        }

        const cornerPos = {
          x: nestPos.x - radius,
          y: yPos - length / 2,
          z: newZ,
        };

        const centerPos = {
          x: nestPos.x,
          y: yPos,
          z: newZ,
        };

        candidates.push({
          position: cornerPos,
          center: centerPos,
          orientation: 'horizontal-y',
          score: this.calculateScore(cornerPos),
          supportType: 'nested',
          supportingIds: [cyl1.uniqueId, cyl2.uniqueId],
        });
      }
    }

    return candidates;
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
    const placed = this.valleyManager.getPlacedCylinders();

    for (const p of placed) {
      if (this.cylindersOverlap(cx, cy, cz, radius, length, p, margin)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check overlap between new cylinder and placed cylinder
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

    if (y1Max <= y2Min + margin || y1Min >= y2Max - margin) {
      return false;
    }

    // Check XZ circle overlap
    if (placed.orientation === 'horizontal-y') {
      const dist = Math.sqrt(
        Math.pow(cx - placed.center.x, 2) +
        Math.pow((cz + radius) - (placed.center.z + placed.radius), 2)
      );
      return dist < radius + placed.radius - margin;
    }

    // For mixed orientations, use AABB
    const diameter = radius * 2;
    const x1 = cx - radius;

    const noOverlap =
      x1 + diameter <= placed.position.x + margin ||
      x1 >= placed.position.x + placed.radius * 2 - margin ||
      cz + diameter <= placed.position.z + margin ||
      cz >= placed.position.z + placed.radius * 2 - margin;

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
   * Update XZ circles for honeycomb calculation
   */
  private updateXZCircles(cylinder: PlacedCylinder): void {
    const layerId = cylinder.layerId;
    if (!this.xzCircles.has(layerId)) {
      this.xzCircles.set(layerId, []);
    }

    this.xzCircles.get(layerId)!.push({
      x: cylinder.center.x,
      z: cylinder.center.z + cylinder.radius,
      radius: cylinder.radius,
    });
  }

  /**
   * Get or create layer ID for a Z position
   */
  private getLayerIdForZ(z: number): number {
    // Find existing layer within tolerance
    for (const layer of this.layers) {
      if (Math.abs(layer.baseZ - z) < 5) {
        // 5cm tolerance
        return layer.id;
      }
    }
    // Create new layer ID
    return this.layers.length;
  }

  /**
   * Calculate placement score (lower is better)
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
    const cylinders = this.valleyManager.getPlacedCylinders();
    if (cylinders.length === 0) return 0;

    let totalCylinderVolume = 0;
    let maxX = 0,
      maxY = 0,
      maxZ = 0;

    for (const cyl of cylinders) {
      totalCylinderVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;

      const dims = {
        x: cyl.radius * 2,
        y: cyl.length,
        z: cyl.radius * 2,
      };

      maxX = Math.max(maxX, cyl.position.x + dims.x);
      maxY = Math.max(maxY, cyl.position.y + dims.y);
      maxZ = Math.max(maxZ, cyl.position.z + dims.z);
    }

    const boundingVolume = maxX * maxY * maxZ;
    return boundingVolume > 0 ? totalCylinderVolume / boundingVolume : 0;
  }

  /**
   * Get placed cylinders
   */
  public getPlacedCylinders(): PlacedCylinder[] {
    return this.valleyManager.getPlacedCylinders();
  }

  /**
   * Get layers
   */
  public getLayers(): CylinderLayer[] {
    return [...this.layers];
  }
}
