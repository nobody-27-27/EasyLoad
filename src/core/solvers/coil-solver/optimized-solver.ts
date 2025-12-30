// src/core/solvers/coil-solver/optimized-solver.ts
// Strip-based cylinder packing - fills rows completely before stacking

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
 * Strip-based cylinder packing solver
 *
 * Strategy:
 * 1. Group cylinders by similar length (within 20cm tolerance)
 * 2. For each group, pack in Y-strips (rows)
 * 3. Fill X direction first, then stack in Z, then move to next Y
 * 4. This maximizes density within each strip
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

    console.log(`=== CYLINDER PACKING (Strip-Based) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    // Group by similar length (within 25cm)
    const groups = this.groupByLength(all, 25);
    console.log(`Created ${groups.length} length groups`);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];
    const unplaced: CargoItem[] = [];

    let currentY = 0;

    // Process each length group
    for (const group of groups) {
      // Sort group by diameter (largest first for better base)
      group.sort((a, b) => b.diameter - a.diameter);

      // Find max length in this group (strip width)
      const stripLength = Math.max(...group.map(c => c.length));

      // Skip if strip doesn't fit
      if (currentY + stripLength > this.L) {
        // Try to fit remaining cylinders individually
        for (const cyl of group) {
          const pos = this.findAnyPosition(cyl, placedBoxes);
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
        continue;
      }

      // Pack this group in the current strip
      const { placedInStrip, remaining } = this.packStrip(group, currentY, stripLength, placedBoxes);

      for (const { cyl, pos } of placedInStrip) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }

      // Move Y forward by strip length
      if (placedInStrip.length > 0) {
        currentY += stripLength;
      }

      // Try to place remaining cylinders elsewhere
      for (const cyl of remaining) {
        const pos = this.findAnyPosition(cyl, placedBoxes);
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
   * Group cylinders by similar length
   */
  private groupByLength(cylinders: Cylinder[], tolerance: number): Cylinder[][] {
    // Sort by length
    const sorted = [...cylinders].sort((a, b) => a.length - b.length);

    const groups: Cylinder[][] = [];
    let currentGroup: Cylinder[] = [];
    let groupStartLength = 0;

    for (const cyl of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(cyl);
        groupStartLength = cyl.length;
      } else if (cyl.length - groupStartLength <= tolerance) {
        currentGroup.push(cyl);
      } else {
        groups.push(currentGroup);
        currentGroup = [cyl];
        groupStartLength = cyl.length;
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Sort groups by max length (shortest first to pack front)
    groups.sort((a, b) => {
      const maxA = Math.max(...a.map(c => c.length));
      const maxB = Math.max(...b.map(c => c.length));
      return maxA - maxB;
    });

    return groups;
  }

  /**
   * Pack cylinders in a strip (Y-slice)
   * Returns placed cylinders and any that couldn't fit
   */
  private packStrip(
    cylinders: Cylinder[],
    stripY: number,
    _stripLength: number,
    existingBoxes: PlacedBox[]
  ): { placedInStrip: Array<{ cyl: Cylinder; pos: { x: number; y: number; z: number } }>; remaining: Cylinder[] } {
    const placedInStrip: Array<{ cyl: Cylinder; pos: { x: number; y: number; z: number } }> = [];
    const remaining: Cylinder[] = [];

    // Track what's been placed in this strip
    const stripBoxes: PlacedBox[] = [];

    // All boxes for collision detection
    const allBoxes = () => [...existingBoxes, ...stripBoxes];

    for (const cyl of cylinders) {
      let placed = false;

      // Try to pack in this strip - fill X first, then stack Z
      // Try each Z level (floor first)
      const zLevels = [0];
      for (const box of stripBoxes) {
        if (!zLevels.includes(box.zMax)) {
          zLevels.push(box.zMax);
        }
      }
      zLevels.sort((a, b) => a - b);

      for (const z of zLevels) {
        if (z + cyl.diameter > this.H) continue;

        // Try X positions from left to right
        for (let x = 0; x + cyl.diameter <= this.W; x++) {
          const pos = { x, y: stripY, z };

          if (this.canPlace(pos, cyl.diameter, cyl.length, allBoxes())) {
            // Check support
            if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, allBoxes())) {
              placedInStrip.push({ cyl, pos });
              stripBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: stripY, yMax: stripY + cyl.length,
                zMin: z, zMax: z + cyl.diameter,
              });
              placed = true;
              break;
            }
          }
        }

        if (placed) break;
      }

      if (!placed) {
        remaining.push(cyl);
      }
    }

    return { placedInStrip, remaining };
  }

  /**
   * Find any valid position in the container
   */
  private findAnyPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Collect all possible Y positions
    const yPositions = new Set<number>();
    yPositions.add(0);
    for (const box of placed) {
      yPositions.add(box.yMin);
      yPositions.add(box.yMax);
    }

    // Collect all possible Z levels
    const zLevels = new Set<number>();
    zLevels.add(0);
    for (const box of placed) {
      zLevels.add(box.zMax);
    }

    const sortedZ = Array.from(zLevels).filter(z => z + diameter <= this.H).sort((a, b) => a - b);
    const sortedY = Array.from(yPositions).filter(y => y + length <= this.L).sort((a, b) => a - b);

    for (const z of sortedZ) {
      for (const y of sortedY) {
        // Try X positions
        for (let x = 0; x + diameter <= this.W; x++) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placed)) {
            if (z === 0 || this.hasSupport(pos, diameter, length, placed)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if position is valid (no collision, within bounds)
   */
  private canPlace(
    pos: { x: number; y: number; z: number },
    diameter: number,
    length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    // Bounds check
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    // Collision check
    const newBox = {
      xMin: x, xMax: x + diameter,
      yMin: y, yMax: y + length,
      zMin: z, zMax: z + diameter,
    };

    for (const box of placed) {
      if (this.boxesOverlap(newBox, box)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if cylinder has support (for z > 0)
   */
  private hasSupport(
    pos: { x: number; y: number; z: number },
    diameter: number,
    length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      // Check if box top is at our bottom (within 1cm tolerance)
      if (Math.abs(box.zMax - z) < 1) {
        // Check XY overlap
        if (box.xMax > x && box.xMin < x + diameter &&
            box.yMax > y && box.yMin < y + length) {
          return true;
        }
      }
    }

    return false;
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
