// src/core/solvers/coil-solver/optimized-solver.ts
// Cross-section packing solver - fills XZ plane completely at each Y slice

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
  placed: boolean;
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
 * Cross-section packing solver
 *
 * Strategy: For each Y slice, pack XZ cross-section as full as possible
 * Groups cylinders by similar length, fills XZ, then moves Y forward
 */
export class OptimizedCoilSolver {
  private W: number;
  private L: number;
  private H: number;

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
          placed: false,
        });
      }
    }

    console.log(`=== CYLINDER PACKING (Multi-Strategy) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    // Try multiple strategies and pick the best result
    const strategies = [
      () => this.packWithStrategy(all, 'length-groups'),
      () => this.packWithStrategy(all, 'diameter-first'),
      () => this.packWithStrategy(all, 'small-first'),
      () => this.packWithStrategy(all, 'large-first'),
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } | null = null;

    for (const strategy of strategies) {
      // Reset placed flags
      all.forEach(c => c.placed = false);
      const result = strategy();

      if (!bestResult || result.placed.length > bestResult.placed.length) {
        bestResult = result;
      }

      // If all placed, we're done
      if (result.unplaced.length === 0) break;
    }

    const { placed, unplaced } = bestResult!;

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

  private packWithStrategy(
    allCylinders: Cylinder[],
    strategy: 'length-groups' | 'diameter-first' | 'small-first' | 'large-first'
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    // Reset
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    let cylinders: Cylinder[];

    switch (strategy) {
      case 'length-groups':
        return this.packByLengthGroups(allCylinders);

      case 'diameter-first':
        // Sort by diameter DESC, then length DESC
        cylinders = [...allCylinders].sort((a, b) => {
          if (Math.abs(a.diameter - b.diameter) > 3) return b.diameter - a.diameter;
          return b.length - a.length;
        });
        break;

      case 'small-first':
        // Small diameter first (better for filling gaps)
        cylinders = [...allCylinders].sort((a, b) => {
          if (Math.abs(a.diameter - b.diameter) > 3) return a.diameter - b.diameter;
          return a.length - b.length;
        });
        break;

      case 'large-first':
        // Large diameter first, short length first
        cylinders = [...allCylinders].sort((a, b) => {
          if (Math.abs(a.diameter - b.diameter) > 3) return b.diameter - a.diameter;
          return a.length - b.length;
        });
        break;
    }

    // Simple greedy packing
    for (const cyl of cylinders) {
      if (cyl.placed) continue;

      const pos = this.findBestPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  private packByLengthGroups(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // Group by length (within 15cm tolerance)
    const groups = this.groupByLength(allCylinders, 15);

    let currentY = 0;

    // Process each length group
    for (const group of groups) {
      // Sort group: smallest diameter first (they stack better)
      group.sort((a, b) => a.diameter - b.diameter);

      const stripLength = Math.max(...group.map(c => c.length));

      if (currentY + stripLength > this.L) {
        continue;
      }

      // Pack this group's XZ cross-section at currentY
      const { placedInSlice, newBoxes } = this.packCrossSection(group, currentY, placedBoxes);

      placed.push(...placedInSlice);
      placedBoxes.push(...newBoxes);

      if (placedInSlice.length > 0) {
        currentY += stripLength;
      }
    }

    // Second pass: try to fit any unplaced cylinders in remaining gaps
    const unplacedCyls = allCylinders.filter(c => !c.placed);
    for (const cyl of unplacedCyls) {
      const pos = this.findGapPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  private findBestPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Collect Y positions
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placedBoxes) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
    }

    // Collect Z levels
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placedBoxes) {
      zSet.add(box.zMax);
    }

    const sortedY = Array.from(ySet).filter(y => y + length <= this.L).sort((a, b) => a - b);
    const sortedZ = Array.from(zSet).filter(z => z + diameter <= this.H).sort((a, b) => a - b);

    // Priority: lowest Y, then lowest Z, then lowest X
    for (const y of sortedY) {
      for (const z of sortedZ) {
        for (let x = 0; x + diameter <= this.W; x++) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (z === 0 || this.hasSupport(pos, diameter, length, placedBoxes)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  private groupByLength(cylinders: Cylinder[], tolerance: number): Cylinder[][] {
    const sorted = [...cylinders].sort((a, b) => a.length - b.length);
    const groups: Cylinder[][] = [];
    let currentGroup: Cylinder[] = [];
    let groupStart = 0;

    for (const cyl of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(cyl);
        groupStart = cyl.length;
      } else if (cyl.length - groupStart <= tolerance) {
        currentGroup.push(cyl);
      } else {
        groups.push(currentGroup);
        currentGroup = [cyl];
        groupStart = cyl.length;
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Sort groups by total count (largest groups first for better packing)
    groups.sort((a, b) => b.length - a.length);

    return groups;
  }

  private packCrossSection(
    cylinders: Cylinder[],
    yPos: number,
    existingBoxes: PlacedBox[]
  ): { placedInSlice: PlacedCylinder[]; newBoxes: PlacedBox[] } {
    const placedInSlice: PlacedCylinder[] = [];
    const newBoxes: PlacedBox[] = [];

    // Track occupied positions in this slice
    const sliceBoxes: PlacedBox[] = [];

    const allBoxes = () => [...existingBoxes, ...sliceBoxes];

    // Pack floor layer first (z=0)
    for (const cyl of cylinders) {
      if (cyl.placed) continue;

      // Try to find position at z=0
      for (let x = 0; x + cyl.diameter <= this.W; x++) {
        const pos = { x, y: yPos, z: 0 };
        if (this.canPlace(pos, cyl.diameter, cyl.length, allBoxes())) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placedInSlice.push(placedCyl);
          cyl.placed = true;

          const box = {
            xMin: x, xMax: x + cyl.diameter,
            yMin: yPos, yMax: yPos + cyl.length,
            zMin: 0, zMax: cyl.diameter,
          };
          sliceBoxes.push(box);
          newBoxes.push(box);
          break;
        }
      }
    }

    // Now try to stack on top of floor layer
    const floorBoxes = sliceBoxes.filter(b => b.zMin === 0);

    for (const cyl of cylinders) {
      if (cyl.placed) continue;

      // Find a floor box to stack on
      for (const support of floorBoxes) {
        const z = support.zMax;
        if (z + cyl.diameter > this.H) continue;

        // Try X positions that overlap with support
        const xStart = Math.max(0, support.xMin - cyl.diameter + 1);
        const xEnd = Math.min(this.W - cyl.diameter, support.xMax - 1);

        for (let x = xStart; x <= xEnd; x++) {
          const pos = { x, y: yPos, z };

          // Check support overlap
          const hasSupport = x < support.xMax && x + cyl.diameter > support.xMin;
          if (!hasSupport) continue;

          if (this.canPlace(pos, cyl.diameter, cyl.length, allBoxes())) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placedInSlice.push(placedCyl);
            cyl.placed = true;

            const box = {
              xMin: x, xMax: x + cyl.diameter,
              yMin: yPos, yMax: yPos + cyl.length,
              zMin: z, zMax: z + cyl.diameter,
            };
            sliceBoxes.push(box);
            newBoxes.push(box);
            break;
          }
        }
        if (cyl.placed) break;
      }
    }

    // Third layer if possible
    const secondLayerBoxes = sliceBoxes.filter(b => b.zMin > 0);

    for (const cyl of cylinders) {
      if (cyl.placed) continue;

      for (const support of secondLayerBoxes) {
        const z = support.zMax;
        if (z + cyl.diameter > this.H) continue;

        const xStart = Math.max(0, support.xMin - cyl.diameter + 1);
        const xEnd = Math.min(this.W - cyl.diameter, support.xMax - 1);

        for (let x = xStart; x <= xEnd; x++) {
          const pos = { x, y: yPos, z };

          const hasSupport = x < support.xMax && x + cyl.diameter > support.xMin;
          if (!hasSupport) continue;

          if (this.canPlace(pos, cyl.diameter, cyl.length, allBoxes())) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placedInSlice.push(placedCyl);
            cyl.placed = true;

            const box = {
              xMin: x, xMax: x + cyl.diameter,
              yMin: yPos, yMax: yPos + cyl.length,
              zMin: z, zMax: z + cyl.diameter,
            };
            sliceBoxes.push(box);
            newBoxes.push(box);
            break;
          }
        }
        if (cyl.placed) break;
      }
    }

    return { placedInSlice, newBoxes };
  }

  private findGapPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Collect Y positions from existing boxes
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placed) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
    }

    const sortedY = Array.from(ySet)
      .filter(y => y + length <= this.L)
      .sort((a, b) => a - b);

    // Collect Z levels
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placed) {
      zSet.add(box.zMax);
    }

    const sortedZ = Array.from(zSet)
      .filter(z => z + diameter <= this.H)
      .sort((a, b) => a - b);

    for (const y of sortedY) {
      for (const z of sortedZ) {
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

  private canPlace(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

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

  private hasSupport(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      if (Math.abs(box.zMax - z) < 1) {
        if (box.xMax > x && box.xMin < x + diameter &&
            box.yMax > y && box.yMin < y + length) {
          return true;
        }
      }
    }
    return false;
  }

  private boxesOverlap(a: PlacedBox, b: PlacedBox): boolean {
    if (a.xMax <= b.xMin || a.xMin >= b.xMax) return false;
    if (a.yMax <= b.yMin || a.yMin >= b.yMax) return false;
    if (a.zMax <= b.zMin || a.zMin >= b.zMax) return false;
    return true;
  }

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
