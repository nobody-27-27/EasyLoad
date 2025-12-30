// src/core/solvers/coil-solver/optimized-solver.ts
// Tight packing solver - fills Y direction first, minimizes gaps

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';

interface Cylinder {
  item: CargoItem;
  diameter: number;
  length: number;
  index: number;
}

interface PlacedBox {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
}

/**
 * Tight packing cylinder solver
 *
 * Strategy: Fill container length (Y) first, pack tightly in cross-section (XZ)
 * Prioritizes: Y (front to back) > Z (floor to ceiling) > X (left to right)
 */
export class OptimizedCoilSolver {
  private W: number;  // Container width (X)
  private L: number;  // Container length (Y)
  private H: number;  // Container height (Z)

  constructor(container: Container, _config: Partial<CoilSolverConfig> = {}) {
    this.W = container.dimensions.width;
    this.L = container.dimensions.length;
    this.H = container.dimensions.height;
  }

  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinders = items.filter(i => i.type === 'cylinder');
    if (cylinders.length === 0) return this.emptyResult();

    // Expand all quantities
    const all: Cylinder[] = [];
    let idx = 0;
    for (const item of cylinders) {
      for (let i = 0; i < item.quantity; i++) {
        all.push({
          item: { ...item, quantity: 1 },
          diameter: item.dimensions.width,
          length: item.dimensions.height,
          index: idx++,
        });
      }
    }

    console.log(`=== CYLINDER PACKING (Tight Fill) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    // Sort by length DESC (longest first to fill Y efficiently), then by diameter DESC
    all.sort((a, b) => {
      const lengthDiff = b.length - a.length;
      if (Math.abs(lengthDiff) > 5) return lengthDiff;
      return b.diameter - a.diameter;
    });

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];
    const unplaced: CargoItem[] = [];

    // Place each cylinder
    for (const cyl of all) {
      const pos = this.findBestPosition(cyl, placedBoxes);

      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      } else {
        unplaced.push(cyl.item);
      }
    }

    console.log(`Placed: ${placed.length}/${all.length}`);
    if (unplaced.length > 0) {
      console.log(`Unplaced: ${unplaced.length}`);
    }

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calcStats(placed, unplaced.length),
    };
  }

  /**
   * Find the best position for a cylinder
   * Priority: Minimize Y, then Z, then X (pack from front, bottom, left)
   */
  private findBestPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    let bestPos: { x: number; y: number; z: number } | null = null;
    let bestScore = Infinity;

    // Generate candidate Y positions
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placed) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
    }
    const yCandidates = Array.from(ySet)
      .filter(y => y >= 0 && y + length <= this.L)
      .sort((a, b) => a - b);

    // Generate candidate Z positions
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placed) {
      zSet.add(box.zMax);
    }
    const zCandidates = Array.from(zSet)
      .filter(z => z >= 0 && z + diameter <= this.H)
      .sort((a, b) => a - b);

    // Generate candidate X positions
    const xSet = new Set<number>();
    xSet.add(0);
    for (const box of placed) {
      xSet.add(box.xMax);
      xSet.add(box.xMin);
    }
    const xCandidates = Array.from(xSet)
      .filter(x => x >= 0 && x + diameter <= this.W)
      .sort((a, b) => a - b);

    // Try all combinations, score by Y * 10000 + Z * 100 + X
    for (const y of yCandidates) {
      for (const z of zCandidates) {
        // Skip if no support for z > 0
        if (z > 0) {
          const hasSupport = this.checkSupport(y, z, diameter, length, placed);
          if (!hasSupport) continue;
        }

        for (const x of xCandidates) {
          if (this.canPlace(x, y, z, diameter, length, placed)) {
            const score = y * 10000 + z * 100 + x;
            if (score < bestScore) {
              bestScore = score;
              bestPos = { x, y, z };
            }
          }
        }
      }
    }

    return bestPos;
  }

  /**
   * Check if there's support at the given Y, Z position
   */
  private checkSupport(
    y: number,
    z: number,
    _diameter: number,
    length: number,
    placed: PlacedBox[]
  ): boolean {
    // Find any box that could support at this Z level
    for (const box of placed) {
      if (Math.abs(box.zMax - z) < 1) {
        // Check Y overlap (for any X)
        if (box.yMax > y && box.yMin < y + length) {
          // This box is at the right height and overlaps in Y
          // We'll verify X overlap in canPlace
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Check if position is valid
   */
  private canPlace(
    x: number, y: number, z: number,
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    // Bounds check
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    const newBox = {
      xMin: x, xMax: x + diameter,
      yMin: y, yMax: y + length,
      zMin: z, zMax: z + diameter,
    };

    // Collision check
    for (const box of placed) {
      if (this.boxesOverlap(newBox, box)) {
        return false;
      }
    }

    // Support check for z > 0
    if (z > 0) {
      let hasSupport = false;
      for (const box of placed) {
        if (Math.abs(box.zMax - z) < 1) {
          // Check XY overlap
          if (box.xMax > x && box.xMin < x + diameter &&
              box.yMax > y && box.yMin < y + length) {
            hasSupport = true;
            break;
          }
        }
      }
      if (!hasSupport) return false;
    }

    return true;
  }

  /**
   * Check if two boxes overlap
   */
  private boxesOverlap(a: PlacedBox, b: PlacedBox): boolean {
    if (a.xMax <= b.xMin || a.xMin >= b.xMax) return false;
    if (a.yMax <= b.yMin || a.yMin >= b.yMax) return false;
    if (a.zMax <= b.zMin || a.zMin >= b.zMax) return false;
    return true;
  }

  /**
   * Create a PlacedCylinder
   */
  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + radius,
        y: pos.y + cyl.length / 2,
        z: pos.z + radius,
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
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
      totalVol += Math.PI * c.radius * c.radius * c.length;
      layers.add(c.layerId);
      maxX = Math.max(maxX, c.position.x + c.radius * 2);
      maxY = Math.max(maxY, c.position.y + c.length);
      maxZ = Math.max(maxZ, c.position.z + c.radius * 2);
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
