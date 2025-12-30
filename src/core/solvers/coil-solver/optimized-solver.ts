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

interface CylinderToPlace {
  item: CargoItem;
  radius: number;
  length: number;
  index: number;
}

interface PlacementPosition {
  x: number;
  y: number;
  z: number;
  orientation: CylinderOrientation;
}

/**
 * OptimizedCoilSolver - Smart 3D cylinder packing
 *
 * Strategy:
 * 1. Group cylinders by similar length to pack together in Y-slices
 * 2. Within each Y-slice, use honeycomb packing in XZ plane
 * 3. Try multiple sorting strategies and pick the best result
 */
export class OptimizedCoilSolver {
  private W: number;
  private L: number;
  private H: number;
  private readonly GAP = 1;

  constructor(container: Container, _config: Partial<CoilSolverConfig> = {}) {
    this.W = container.dimensions.width;
    this.L = container.dimensions.length;
    this.H = container.dimensions.height;
  }

  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinderItems = items.filter((item) => item.type === 'cylinder');
    if (cylinderItems.length === 0) return this.emptyResult();

    // Expand all items
    const allCylinders: CylinderToPlace[] = [];
    let idx = 0;
    for (const item of cylinderItems) {
      for (let i = 0; i < item.quantity; i++) {
        allCylinders.push({
          item: { ...item, quantity: 1 },
          radius: item.dimensions.width / 2,
          length: item.dimensions.height,
          index: idx++,
        });
      }
    }

    console.log(`=== COIL SOLVER ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Total cylinders: ${allCylinders.length}`);

    // Try different strategies
    const results = [
      this.packByLengthGroups(allCylinders),
      this.packGreedyByVolume(allCylinders),
      this.packGreedyByDiameter(allCylinders),
    ];

    // Pick best result
    let best = results[0];
    for (const r of results) {
      if (r.placed.length > best.placed.length) {
        best = r;
      }
    }

    console.log(`BEST: ${best.placed.length}/${allCylinders.length} placed`);

    return {
      placedCylinders: best.placed,
      unplacedItems: best.unplaced,
      statistics: this.calcStats(best.placed, best.unplaced.length),
    };
  }

  /**
   * Pack by grouping similar lengths together
   */
  private packByLengthGroups(cylinders: CylinderToPlace[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    // Group by similar length (within 15cm tolerance)
    const groups: CylinderToPlace[][] = [];
    const sorted = [...cylinders].sort((a, b) => b.length - a.length);

    for (const cyl of sorted) {
      let added = false;
      for (const group of groups) {
        if (Math.abs(group[0].length - cyl.length) <= 15) {
          group.push(cyl);
          added = true;
          break;
        }
      }
      if (!added) {
        groups.push([cyl]);
      }
    }

    // Sort each group by diameter (largest first) for better honeycomb packing
    for (const group of groups) {
      group.sort((a, b) => b.radius - a.radius);
    }

    console.log(`Created ${groups.length} length groups:`, groups.map(g => `${g.length} items @ ~${g[0].length}cm`));

    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];
    let currentY = 0;

    // Pack each group as a Y-slice
    for (const group of groups) {
      const maxLength = Math.max(...group.map(c => c.length));

      // Pack this group starting at currentY
      for (const cyl of group) {
        const pos = this.findPositionInYSlice(cyl, placed, currentY, currentY + maxLength);

        if (pos) {
          placed.push(this.createPlacedCylinder(cyl, pos));
        } else {
          // Try anywhere else in the container
          const fallbackPos = this.findAnyPosition(cyl, placed);
          if (fallbackPos) {
            placed.push(this.createPlacedCylinder(cyl, fallbackPos));
          } else {
            unplaced.push(cyl.item);
          }
        }
      }

      currentY += maxLength + this.GAP;
    }

    console.log(`Length-groups strategy: ${placed.length}/${cylinders.length}`);
    return { placed, unplaced };
  }

  /**
   * Find position within a Y-slice
   */
  private findPositionInYSlice(
    cyl: CylinderToPlace,
    placed: PlacedCylinder[],
    yMin: number,
    _yMax: number
  ): PlacementPosition | null {
    const { radius, length } = cyl;
    const diameter = radius * 2;

    if (diameter > this.W || diameter > this.H) return null;
    if (yMin + length > this.L) return null;

    const rowHeight = radius * Math.sqrt(3);
    let bestPos: PlacementPosition | null = null;
    let bestScore = Infinity;

    // Generate honeycomb positions in XZ plane
    for (let row = 0; row < 20; row++) {
      const z = row * rowHeight;
      if (z + diameter > this.H) break;

      const xOffset = (row % 2 === 1) ? radius : 0;

      for (let x = radius + xOffset; x + radius <= this.W; x += diameter + this.GAP) {
        // Try placing at yMin
        if (this.canPlace(x, yMin, z, radius, length, 'horizontal-y', placed)) {
          const score = z * 1000 + x;
          if (score < bestScore) {
            bestScore = score;
            bestPos = { x, y: yMin, z, orientation: 'horizontal-y' };
          }
        }
      }
    }

    return bestPos;
  }

  /**
   * Find any valid position in container
   */
  private findAnyPosition(cyl: CylinderToPlace, placed: PlacedCylinder[]): PlacementPosition | null {
    const { radius, length } = cyl;
    const diameter = radius * 2;
    const rowHeight = radius * Math.sqrt(3);

    let bestPos: PlacementPosition | null = null;
    let bestScore = Infinity;

    // Collect all Y start positions
    const yStarts = new Set<number>([0]);
    for (const p of placed) {
      if (p.orientation === 'horizontal-y') {
        yStarts.add(p.position.y);
        yStarts.add(p.position.y + p.length + this.GAP);
      }
    }

    for (const y of yStarts) {
      if (y + length > this.L) continue;

      for (let row = 0; row < 20; row++) {
        const z = row * rowHeight;
        if (z + diameter > this.H) break;

        const xOffset = (row % 2 === 1) ? radius : 0;

        for (let x = radius + xOffset; x + radius <= this.W; x += diameter + this.GAP) {
          if (this.canPlace(x, y, z, radius, length, 'horizontal-y', placed)) {
            const score = y * 100000 + z * 1000 + x;
            if (score < bestScore) {
              bestScore = score;
              bestPos = { x, y, z, orientation: 'horizontal-y' };
            }
          }
        }
      }
    }

    return bestPos;
  }

  /**
   * Greedy packing by volume
   */
  private packGreedyByVolume(cylinders: CylinderToPlace[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const sorted = [...cylinders].sort((a, b) =>
      (b.radius * b.radius * b.length) - (a.radius * a.radius * a.length)
    );
    return this.packGreedy(sorted, 'volume');
  }

  /**
   * Greedy packing by diameter
   */
  private packGreedyByDiameter(cylinders: CylinderToPlace[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const sorted = [...cylinders].sort((a, b) => b.radius - a.radius);
    return this.packGreedy(sorted, 'diameter');
  }

  /**
   * Generic greedy packing
   */
  private packGreedy(cylinders: CylinderToPlace[], _name: string): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    for (const cyl of cylinders) {
      const pos = this.findBestGreedyPosition(cyl, placed);
      if (pos) {
        placed.push(this.createPlacedCylinder(cyl, pos));
      } else {
        unplaced.push(cyl.item);
      }
    }

    return { placed, unplaced };
  }

  /**
   * Find best position using greedy approach
   */
  private findBestGreedyPosition(cyl: CylinderToPlace, placed: PlacedCylinder[]): PlacementPosition | null {
    const { radius, length } = cyl;
    const diameter = radius * 2;
    const rowHeight = radius * Math.sqrt(3);

    let bestPos: PlacementPosition | null = null;
    let bestScore = Infinity;

    // Collect Y positions
    const yStarts = new Set<number>([0]);
    for (const p of placed) {
      if (p.orientation === 'horizontal-y') {
        yStarts.add(p.position.y);
        yStarts.add(p.position.y + p.length + this.GAP);
      }
    }

    // Also add intermediate positions for better packing
    for (let y = 0; y <= this.L - length; y += Math.min(length, 50)) {
      yStarts.add(y);
    }

    for (const y of yStarts) {
      if (y + length > this.L) continue;

      for (let row = 0; row < 20; row++) {
        const z = row * rowHeight;
        if (z + diameter > this.H) break;

        const xOffset = (row % 2 === 1) ? radius : 0;

        for (let x = radius + xOffset; x + radius <= this.W; x += diameter + this.GAP) {
          if (this.canPlace(x, y, z, radius, length, 'horizontal-y', placed)) {
            const score = y * 100000 + z * 1000 + x;
            if (score < bestScore) {
              bestScore = score;
              bestPos = { x, y, z, orientation: 'horizontal-y' };
            }
          }
        }
      }
    }

    return bestPos;
  }

  /**
   * Check if cylinder can be placed
   */
  private canPlace(
    x: number, y: number, z: number,
    radius: number, length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder[]
  ): boolean {
    const diameter = radius * 2;

    // Bounds check
    if (x - radius < 0 || x + radius > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    // Collision check
    for (const p of placed) {
      if (this.collides(x, y, z, radius, length, orientation, p)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check collision between cylinders
   */
  private collides(
    x: number, y: number, z: number,
    radius: number, length: number,
    orientation: CylinderOrientation,
    other: PlacedCylinder
  ): boolean {
    const minDist = radius + other.radius + this.GAP;

    if (orientation === 'horizontal-y' && other.orientation === 'horizontal-y') {
      // Check Y overlap
      if (y + length <= other.position.y || y >= other.position.y + other.length) {
        return false;
      }
      // Check XZ circle distance
      const c1z = z + radius;
      const c2z = other.position.z + other.radius;
      const dist = Math.sqrt((x - other.center.x) ** 2 + (c1z - c2z) ** 2);
      return dist < minDist;
    }

    // Fallback to AABB
    const bb1 = this.getBB(x, y, z, radius, length, orientation);
    const bb2 = this.getPlacedBB(other);
    return this.boxesOverlap(bb1, bb2);
  }

  private getBB(x: number, y: number, z: number, r: number, len: number, orient: CylinderOrientation) {
    if (orient === 'horizontal-y') {
      return { minX: x - r, maxX: x + r, minY: y, maxY: y + len, minZ: z, maxZ: z + r * 2 };
    }
    return { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r, minZ: z, maxZ: z + len };
  }

  private getPlacedBB(p: PlacedCylinder) {
    if (p.orientation === 'horizontal-y') {
      return {
        minX: p.center.x - p.radius, maxX: p.center.x + p.radius,
        minY: p.position.y, maxY: p.position.y + p.length,
        minZ: p.position.z, maxZ: p.position.z + p.radius * 2,
      };
    }
    return {
      minX: p.center.x - p.radius, maxX: p.center.x + p.radius,
      minY: p.center.y - p.radius, maxY: p.center.y + p.radius,
      minZ: p.position.z, maxZ: p.position.z + p.length,
    };
  }

  private boxesOverlap(a: ReturnType<typeof this.getBB>, b: ReturnType<typeof this.getBB>): boolean {
    return !(a.maxX <= b.minX || a.minX >= b.maxX ||
             a.maxY <= b.minY || a.minY >= b.maxY ||
             a.maxZ <= b.minZ || a.minZ >= b.maxZ);
  }

  private createPlacedCylinder(cyl: CylinderToPlace, pos: PlacementPosition): PlacedCylinder {
    const { radius, length } = cyl;
    const cornerPos = { x: pos.x - radius, y: pos.y, z: pos.z };
    const centerPos = { x: pos.x, y: pos.y + length / 2, z: pos.z + radius };

    return {
      item: cyl.item,
      uniqueId: `${cyl.item.id}_${cyl.index}_${pos.orientation[0]}`,
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

  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
    if (placed.length === 0) {
      return { totalVolumePlaced: 0, containerVolumeUsed: 0, volumeEfficiency: 0, layerCount: 0, itemsPlaced: 0, itemsFailed: failed };
    }

    let totalVol = 0, maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius ** 2 * c.length;
      layers.add(c.layerId);
      const bb = this.getPlacedBB(c);
      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
      maxZ = Math.max(maxZ, bb.maxZ);
    }

    return {
      totalVolumePlaced: totalVol,
      containerVolumeUsed: maxX * maxY * maxZ,
      volumeEfficiency: totalVol / (maxX * maxY * maxZ),
      layerCount: layers.size,
      itemsPlaced: placed.length,
      itemsFailed: failed,
    };
  }

  private emptyResult(): CoilSolverResult {
    return {
      placedCylinders: [],
      unplacedItems: [],
      statistics: { totalVolumePlaced: 0, containerVolumeUsed: 0, volumeEfficiency: 0, layerCount: 0, itemsPlaced: 0, itemsFailed: 0 },
    };
  }
}
