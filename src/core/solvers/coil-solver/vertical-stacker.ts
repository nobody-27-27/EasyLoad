// src/core/solvers/coil-solver/vertical-stacker.ts

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  PlacementCandidate,
  CoilSolverConfig,
  CylinderLayer,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';
import { ValleyManager } from './valley-manager';

/**
 * VerticalStacker handles the placement of cylinders in upright (vertical) orientation.
 * Think of coins stacked in columns - this is "column generation" strategy.
 *
 * Strategy:
 * 1. Fill the floor with cylinders in a tight grid pattern
 * 2. For upper layers, find valleys between floor cylinders for honeycomb nesting
 * 3. Continue stacking layers until container height is reached
 *
 * Physical Model:
 * - Cylinders stand upright (axis along Z/height)
 * - Each cylinder's circular footprint is in the XY plane
 * - Stacking is along the Z axis
 */
export class VerticalStacker {
  private container: Container;
  private config: CoilSolverConfig;
  private valleyManager: ValleyManager;
  private layers: CylinderLayer[] = [];

  constructor(container: Container, config: CoilSolverConfig) {
    this.container = container;
    this.config = config;
    this.valleyManager = new ValleyManager(container, config);
  }

  /**
   * Solve vertical stacking for a set of items
   * Returns placed cylinders and items that couldn't be placed
   */
  public solve(items: CargoItem[]): {
    placed: PlacedCylinder[];
    unplaced: CargoItem[];
  } {
    this.valleyManager.clear();
    this.layers = [];

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

    // 1. Try floor positions first (for first layer)
    const floorCandidates = this.valleyManager.findFloorPositions(radius, length, 'vertical');
    candidates.push(...floorCandidates);

    // 2. Try stacking on existing cylinders
    if (item.stackable) {
      const stackingCandidates = this.valleyManager.findStackingPositions(radius, length, 'vertical');
      candidates.push(...stackingCandidates);
    }

    // 3. Try valley/nesting positions (honeycomb)
    const valleyCandidates = this.valleyManager.findValleyPositions(radius, length, false);
    candidates.push(...valleyCandidates);

    // Sort by score and return best
    candidates.sort((a, b) => a.score - b.score);
    return candidates.length > 0 ? candidates[0] : null;
  }

  /**
   * Create a PlacedCylinder from an item and placement
   */
  private createPlacedCylinder(item: CargoItem, placement: PlacementCandidate): PlacedCylinder {
    const radius = item.dimensions.width / 2;
    const length = item.dimensions.height;

    return {
      item,
      uniqueId: `${item.id}_v_${Math.random().toString(36).substr(2, 6)}`,
      position: placement.position,
      center: placement.center,
      radius,
      length,
      orientation: 'vertical',
      rotation: ORIENTATION_ROTATIONS.vertical,
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
        height: cylinder.length,
        orientation: 'vertical',
        cylinders: [],
      };
      this.layers.push(layer);
      this.layers.sort((a, b) => a.baseZ - b.baseZ);
    }

    layer.cylinders.push(cylinder);
    layer.height = Math.max(layer.height, cylinder.length);
  }

  /**
   * Get or create layer ID for a Z position
   */
  private getLayerIdForZ(z: number): number {
    // Find existing layer within tolerance
    for (const layer of this.layers) {
      if (Math.abs(layer.baseZ - z) < 1) {
        // 1cm tolerance
        return layer.id;
      }
    }
    // Create new layer ID
    return this.layers.length;
  }

  /**
   * Get optimized floor grid for cylinders of a given radius
   * Uses hexagonal packing for better space efficiency
   */
  public getOptimalFloorGrid(radius: number): Array<{ x: number; y: number }> {
    const positions: Array<{ x: number; y: number }> = [];
    const diameter = radius * 2;
    const margin = this.config.wallMargin;

    // Hexagonal packing parameters
    const rowSpacing = diameter * Math.sqrt(3) / 2; // Vertical spacing between rows
    const colSpacing = diameter; // Horizontal spacing

    let row = 0;
    let y = margin + radius;

    while (y + radius <= this.container.dimensions.length - margin) {
      const isOddRow = row % 2 === 1;
      const xOffset = isOddRow ? radius : 0;

      let x = margin + radius + xOffset;

      while (x + radius <= this.container.dimensions.width - margin) {
        positions.push({ x, y });
        x += colSpacing;
      }

      y += rowSpacing;
      row++;
    }

    return positions;
  }

  /**
   * Calculate volume efficiency for current placement
   */
  public calculateEfficiency(): number {
    const cylinders = this.valleyManager.getPlacedCylinders();
    if (cylinders.length === 0) return 0;

    let totalCylinderVolume = 0;
    let maxX = 0, maxY = 0, maxZ = 0;

    for (const cyl of cylinders) {
      totalCylinderVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;

      maxX = Math.max(maxX, cyl.position.x + cyl.radius * 2);
      maxY = Math.max(maxY, cyl.position.y + cyl.radius * 2);
      maxZ = Math.max(maxZ, cyl.position.z + cyl.length);
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
