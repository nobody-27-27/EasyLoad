// src/core/solvers/coil-solver/optimized-solver.ts

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';
import type { CylinderOrientation } from '../../math/cylinder-math/cylinder-geometry';

interface Position {
  x: number;
  y: number;
  z: number;
  orientation: CylinderOrientation;
}

/**
 * OptimizedCoilSolver - Layer-based 3D cylinder packing
 *
 * Strategy:
 * 1. Sort cylinders by length (group similar lengths together)
 * 2. Place cylinders in Y-layers (along container length)
 * 3. Within each layer, use honeycomb packing in XZ plane
 * 4. Try multiple strategies and pick the best result
 */
export class OptimizedCoilSolver {
  private container: Container;
  private readonly GAP = 0.5; // Minimal gap between cylinders

  constructor(container: Container, _config: Partial<CoilSolverConfig> = {}) {
    this.container = container;
  }

  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinderItems = items.filter((item) => item.type === 'cylinder');
    if (cylinderItems.length === 0) return this.emptyResult();

    // Expand quantities
    const allItems: CargoItem[] = [];
    for (const item of cylinderItems) {
      for (let i = 0; i < item.quantity; i++) {
        allItems.push({ ...item, quantity: 1 });
      }
    }

    console.log(`Packing ${allItems.length} cylinders into ${this.container.dimensions.width}x${this.container.dimensions.length}x${this.container.dimensions.height}cm container`);

    // Try multiple sorting strategies
    const strategies = [
      { name: 'length-then-diameter', sort: this.sortByLengthThenDiameter.bind(this) },
      { name: 'diameter-then-length', sort: this.sortByDiameterThenLength.bind(this) },
      { name: 'volume-desc', sort: this.sortByVolume.bind(this) },
      { name: 'diameter-desc', sort: this.sortByDiameter.bind(this) },
    ];

    let bestPlaced: PlacedCylinder[] = [];
    let bestUnplaced: CargoItem[] = allItems;
    let bestStrategy = '';

    for (const strategy of strategies) {
      const sorted = strategy.sort([...allItems]);
      const result = this.packCylinders(sorted);

      if (result.placed.length > bestPlaced.length) {
        bestPlaced = result.placed;
        bestUnplaced = result.unplaced;
        bestStrategy = strategy.name;
      }

      if (result.placed.length === allItems.length) {
        console.log(`✓ All ${allItems.length} items placed with: ${strategy.name}`);
        break;
      }
    }

    console.log(`Best: ${bestStrategy} - ${bestPlaced.length}/${allItems.length} placed`);

    return {
      placedCylinders: bestPlaced,
      unplacedItems: bestUnplaced,
      statistics: this.calcStats(bestPlaced, bestUnplaced.length),
    };
  }

  /**
   * Main packing algorithm - fills container layer by layer along Y axis
   */
  private packCylinders(items: CargoItem[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    const W = this.container.dimensions.width;
    const L = this.container.dimensions.length;
    const H = this.container.dimensions.height;

    for (const item of items) {
      const radius = item.dimensions.width / 2;
      const length = item.dimensions.height;
      const diameter = radius * 2;

      let bestPos: Position | null = null;
      let bestScore = Infinity;

      // Try horizontal placement (cylinder axis along Y)
      if (diameter <= W && length <= L && diameter <= H) {
        const pos = this.findHorizontalPosition(radius, length, placed, W, L, H);
        if (pos) {
          const score = pos.y * 10000 + pos.z * 100 + pos.x;
          if (score < bestScore) {
            bestScore = score;
            bestPos = { ...pos, orientation: 'horizontal-y' };
          }
        }
      }

      // Try vertical placement (cylinder axis along Z)
      if (diameter <= W && diameter <= L && length <= H) {
        const pos = this.findVerticalPosition(radius, length, placed, W, L, H);
        if (pos) {
          const score = pos.y * 10000 + pos.z * 100 + pos.x;
          if (score < bestScore) {
            bestScore = score;
            bestPos = { ...pos, orientation: 'vertical' };
          }
        }
      }

      if (bestPos) {
        placed.push(this.createPlaced(item, bestPos, radius, length));
      } else {
        unplaced.push(item);
      }
    }

    return { placed, unplaced };
  }

  /**
   * Find position for horizontal cylinder (axis along Y)
   */
  private findHorizontalPosition(
    radius: number,
    length: number,
    placed: PlacedCylinder[],
    W: number,
    L: number,
    H: number
  ): { x: number; y: number; z: number } | null {
    const diameter = radius * 2;
    const rowHeight = radius * Math.sqrt(3); // Honeycomb row spacing

    // Get all existing Y positions where horizontal cylinders start
    const yPositions = new Set<number>([0]);
    for (const p of placed) {
      if (p.orientation === 'horizontal-y') {
        yPositions.add(p.position.y);
        yPositions.add(p.position.y + p.length + this.GAP);
      }
    }

    // Sort Y positions
    const sortedY = Array.from(yPositions).sort((a, b) => a - b);

    // Try each Y position
    for (const y of sortedY) {
      if (y + length > L) continue;

      // Try honeycomb pattern in XZ plane
      for (let row = 0; row < 20; row++) {
        const z = row * rowHeight;
        if (z + diameter > H) break;

        const xOffset = (row % 2 === 1) ? radius : 0;

        // Try positions along X
        for (let x = radius + xOffset; x + radius <= W; x += diameter + this.GAP) {
          if (this.canPlaceHorizontal(x, y, z, radius, length, placed)) {
            return { x, y, z };
          }
        }
      }
    }

    return null;
  }

  /**
   * Find position for vertical cylinder (axis along Z)
   */
  private findVerticalPosition(
    radius: number,
    length: number,
    placed: PlacedCylinder[],
    W: number,
    L: number,
    H: number
  ): { x: number; y: number; z: number } | null {
    const diameter = radius * 2;
    const rowSpacing = radius * Math.sqrt(3);

    // Hexagonal grid in XY plane
    for (let row = 0; row < 100; row++) {
      const y = radius + row * rowSpacing;
      if (y + radius > L) break;

      const xOffset = (row % 2 === 1) ? radius : 0;

      for (let x = radius + xOffset; x + radius <= W; x += diameter + this.GAP) {
        // Stack in Z
        for (let z = 0; z + length <= H; z += length + this.GAP) {
          if (this.canPlaceVertical(x, y, z, radius, length, placed)) {
            return { x, y, z };
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if horizontal cylinder can be placed
   */
  private canPlaceHorizontal(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    placed: PlacedCylinder[]
  ): boolean {
    const diameter = radius * 2;
    const W = this.container.dimensions.width;
    const L = this.container.dimensions.length;
    const H = this.container.dimensions.height;

    // Bounds check
    if (x - radius < 0 || x + radius > W) return false;
    if (y < 0 || y + length > L) return false;
    if (z < 0 || z + diameter > H) return false;

    // Collision check
    for (const p of placed) {
      if (this.collidesHorizontal(x, y, z, radius, length, p)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if vertical cylinder can be placed
   */
  private canPlaceVertical(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    placed: PlacedCylinder[]
  ): boolean {
    const W = this.container.dimensions.width;
    const L = this.container.dimensions.length;
    const H = this.container.dimensions.height;

    // Bounds check
    if (x - radius < 0 || x + radius > W) return false;
    if (y - radius < 0 || y + radius > L) return false;
    if (z < 0 || z + length > H) return false;

    // Collision check
    for (const p of placed) {
      if (this.collidesVertical(x, y, z, radius, length, p)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Collision detection for horizontal cylinder
   */
  private collidesHorizontal(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    other: PlacedCylinder
  ): boolean {
    const minDist = radius + other.radius + this.GAP;

    if (other.orientation === 'horizontal-y') {
      // Both horizontal - check Y overlap first
      const y1End = y + length;
      const y2End = other.position.y + other.length;
      if (y1End <= other.position.y || y >= y2End) return false;

      // Circle collision in XZ plane
      const c1z = z + radius;
      const c2z = other.position.z + other.radius;
      const dist = Math.sqrt((x - other.center.x) ** 2 + (c1z - c2z) ** 2);
      return dist < minDist;
    } else {
      // Other is vertical - AABB check
      const bb1 = {
        minX: x - radius, maxX: x + radius,
        minY: y, maxY: y + length,
        minZ: z, maxZ: z + radius * 2,
      };
      const bb2 = {
        minX: other.center.x - other.radius, maxX: other.center.x + other.radius,
        minY: other.center.y - other.radius, maxY: other.center.y + other.radius,
        minZ: other.position.z, maxZ: other.position.z + other.length,
      };
      return this.aabbOverlap(bb1, bb2);
    }
  }

  /**
   * Collision detection for vertical cylinder
   */
  private collidesVertical(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    other: PlacedCylinder
  ): boolean {
    const minDist = radius + other.radius + this.GAP;

    if (other.orientation === 'vertical') {
      // Both vertical - check Z overlap first
      const z1End = z + length;
      const z2End = other.position.z + other.length;
      if (z1End <= other.position.z || z >= z2End) return false;

      // Circle collision in XY plane
      const dist = Math.sqrt((x - other.center.x) ** 2 + (y - other.center.y) ** 2);
      return dist < minDist;
    } else {
      // Other is horizontal - AABB check
      const bb1 = {
        minX: x - radius, maxX: x + radius,
        minY: y - radius, maxY: y + radius,
        minZ: z, maxZ: z + length,
      };
      const bb2 = {
        minX: other.center.x - other.radius, maxX: other.center.x + other.radius,
        minY: other.position.y, maxY: other.position.y + other.length,
        minZ: other.position.z, maxZ: other.position.z + other.radius * 2,
      };
      return this.aabbOverlap(bb1, bb2);
    }
  }

  private aabbOverlap(
    a: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number },
    b: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number }
  ): boolean {
    return !(a.maxX <= b.minX || a.minX >= b.maxX ||
             a.maxY <= b.minY || a.minY >= b.maxY ||
             a.maxZ <= b.minZ || a.minZ >= b.maxZ);
  }

  private createPlaced(item: CargoItem, pos: Position, radius: number, length: number): PlacedCylinder {
    let cornerPos: { x: number; y: number; z: number };
    let centerPos: { x: number; y: number; z: number };

    if (pos.orientation === 'horizontal-y') {
      cornerPos = { x: pos.x - radius, y: pos.y, z: pos.z };
      centerPos = { x: pos.x, y: pos.y + length / 2, z: pos.z + radius };
    } else {
      cornerPos = { x: pos.x - radius, y: pos.y - radius, z: pos.z };
      centerPos = { x: pos.x, y: pos.y, z: pos.z + length / 2 };
    }

    return {
      item,
      uniqueId: `${item.id}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
      position: cornerPos,
      center: centerPos,
      radius,
      length,
      orientation: pos.orientation,
      rotation: ORIENTATION_ROTATIONS[pos.orientation],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  // Sorting functions
  private sortByLengthThenDiameter(items: CargoItem[]): CargoItem[] {
    return [...items].sort((a, b) => {
      const lenDiff = b.dimensions.height - a.dimensions.height;
      if (Math.abs(lenDiff) > 5) return lenDiff;
      return b.dimensions.width - a.dimensions.width;
    });
  }

  private sortByDiameterThenLength(items: CargoItem[]): CargoItem[] {
    return [...items].sort((a, b) => {
      const diamDiff = b.dimensions.width - a.dimensions.width;
      if (Math.abs(diamDiff) > 5) return diamDiff;
      return b.dimensions.height - a.dimensions.height;
    });
  }

  private sortByVolume(items: CargoItem[]): CargoItem[] {
    const vol = (i: CargoItem) => Math.PI * (i.dimensions.width / 2) ** 2 * i.dimensions.height;
    return [...items].sort((a, b) => vol(b) - vol(a));
  }

  private sortByDiameter(items: CargoItem[]): CargoItem[] {
    return [...items].sort((a, b) => b.dimensions.width - a.dimensions.width);
  }

  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
    if (placed.length === 0) {
      return {
        totalVolumePlaced: 0,
        containerVolumeUsed: 0,
        volumeEfficiency: 0,
        layerCount: 0,
        itemsPlaced: 0,
        itemsFailed: failed,
      };
    }

    let totalVol = 0;
    let maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius ** 2 * c.length;
      layers.add(c.layerId);

      if (c.orientation === 'horizontal-y') {
        maxX = Math.max(maxX, c.center.x + c.radius);
        maxY = Math.max(maxY, c.position.y + c.length);
        maxZ = Math.max(maxZ, c.position.z + c.radius * 2);
      } else {
        maxX = Math.max(maxX, c.center.x + c.radius);
        maxY = Math.max(maxY, c.center.y + c.radius);
        maxZ = Math.max(maxZ, c.position.z + c.length);
      }
    }

    const usedVol = maxX * maxY * maxZ;

    return {
      totalVolumePlaced: totalVol,
      containerVolumeUsed: usedVol,
      volumeEfficiency: usedVol > 0 ? totalVol / usedVol : 0,
      layerCount: layers.size,
      itemsPlaced: placed.length,
      itemsFailed: failed,
    };
  }

  private emptyResult(): CoilSolverResult {
    return {
      placedCylinders: [],
      unplacedItems: [],
      statistics: {
        totalVolumePlaced: 0,
        containerVolumeUsed: 0,
        volumeEfficiency: 0,
        layerCount: 0,
        itemsPlaced: 0,
        itemsFailed: 0,
      },
    };
  }
}
