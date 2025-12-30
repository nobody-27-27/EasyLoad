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
      () => this.packWithStrategy(all, 'by-diameter-groups'),
      () => this.packWithStrategy(all, 'volume-desc'),
      () => this.packMixedOptimal(all), // New: optimized mixed packing
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      // Reset placed flags
      all.forEach(c => c.placed = false);
      const result = strategy();

      // Track boxes for potential further optimization
      const placedBoxes: PlacedBox[] = result.placed.map(p => ({
        xMin: p.position.x, xMax: p.position.x + p.radius * 2,
        yMin: p.position.y, yMax: p.position.y + p.length,
        zMin: p.position.z, zMax: p.position.z + p.radius * 2,
      }));

      if (!bestResult || result.placed.length > bestResult.placed.length) {
        bestResult = { ...result, placedBoxes };
      }

      // If all placed, we're done
      if (result.unplaced.length === 0) break;
    }

    // Final attempt: exhaustive search for any unplaced in best result
    if (bestResult!.unplaced.length > 0) {
      // Count how many of each cargo were placed
      const placedCounts = new Map<string, number>();
      for (const p of bestResult!.placed) {
        const key = `${p.item.name}_${p.radius * 2}_${p.length}`;
        placedCounts.set(key, (placedCounts.get(key) || 0) + 1);
      }

      // Find unplaced cylinders
      const usedCounts = new Map<string, number>();
      const unplacedCyls: Cylinder[] = [];

      for (const cyl of all) {
        const key = `${cyl.item.name}_${cyl.diameter}_${cyl.length}`;
        const placed = placedCounts.get(key) || 0;
        const used = usedCounts.get(key) || 0;

        if (used < placed) {
          usedCounts.set(key, used + 1);
        } else {
          unplacedCyls.push(cyl);
        }
      }

      // Sort by smallest diameter first (easier to fit in gaps)
      unplacedCyls.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of unplacedCyls) {
        const pos = this.exhaustiveSearch(cyl, bestResult!.placedBoxes);
        if (pos) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          bestResult!.placed.push(placedCyl);
          bestResult!.placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.length,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
          cyl.placed = true;
        }
      }

      bestResult!.unplaced = unplacedCyls.filter(c => !c.placed).map(c => c.item);
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
    strategy: 'length-groups' | 'diameter-first' | 'small-first' | 'large-first' | 'by-diameter-groups' | 'volume-desc'
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    // Reset
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    let cylinders: Cylinder[];

    switch (strategy) {
      case 'length-groups':
        return this.packByLengthGroups(allCylinders);

      case 'by-diameter-groups':
        return this.packByDiameterGroups(allCylinders);

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

      case 'volume-desc':
        // Sort by volume (largest first)
        cylinders = [...allCylinders].sort((a, b) => {
          const volA = Math.PI * (a.diameter / 2) ** 2 * a.length;
          const volB = Math.PI * (b.diameter / 2) ** 2 * b.length;
          return volB - volA;
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

  /**
   * Mixed optimal packing - tries to maximize floor usage with mixed diameters
   * Strategy: For each Y position, pack floor layer optimally, then stack
   */
  private packMixedOptimal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // Sort by length (longest first) to minimize wasted Y space
    const sortedByLength = [...allCylinders].sort((a, b) => b.length - a.length);

    // Group by similar lengths (within 5cm)
    const lengthGroups = this.groupByLength(sortedByLength, 5);

    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));

      if (currentY + maxLength > this.L) {
        // Can't fit this group's length, try to place individually in gaps
        continue;
      }

      // For this Y slice, pack the floor optimally by trying different diameter combinations
      // Sort by diameter (largest first for floor)
      const byDiameter = [...group].sort((a, b) => b.diameter - a.diameter);

      // Pack floor layer (z=0)
      let floorPacked = 0;
      for (const cyl of byDiameter) {
        if (cyl.placed) continue;

        // Find best X position on floor at this Y
        for (let x = 0; x + cyl.diameter <= this.W; x++) {
          const pos = { x, y: currentY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.length,
              zMin: pos.z, zMax: pos.z + cyl.diameter,
            });
            floorPacked++;
            break;
          }
        }
      }

      // Stack on floor layer - smallest diameters on top (more stable)
      const floor = placedBoxes.filter(b => b.yMin === currentY && b.zMin === 0);
      const remaining = group.filter(c => !c.placed).sort((a, b) => a.diameter - b.diameter);

      for (const cyl of remaining) {
        // Find any floor box to stack on
        for (const support of floor) {
          const z = support.zMax;
          if (z + cyl.diameter > this.H) continue;

          for (let x = Math.max(0, support.xMin); x + cyl.diameter <= Math.min(this.W, support.xMax + cyl.diameter); x++) {
            // Ensure overlap with support
            if (x >= support.xMax || x + cyl.diameter <= support.xMin) continue;

            const pos = { x, y: currentY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: pos.z, zMax: pos.z + cyl.diameter,
              });
              break;
            }
          }
          if (cyl.placed) break;
        }
      }

      // Third layer if possible
      const secondLayer = placedBoxes.filter(b => b.yMin === currentY && b.zMin > 0 && b.zMin < this.H / 2);
      const stillRemaining = group.filter(c => !c.placed).sort((a, b) => a.diameter - b.diameter);

      for (const cyl of stillRemaining) {
        for (const support of secondLayer) {
          const z = support.zMax;
          if (z + cyl.diameter > this.H) continue;

          for (let x = Math.max(0, support.xMin); x + cyl.diameter <= Math.min(this.W, support.xMax + cyl.diameter); x++) {
            if (x >= support.xMax || x + cyl.diameter <= support.xMin) continue;

            const pos = { x, y: currentY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: pos.z, zMax: pos.z + cyl.diameter,
              });
              break;
            }
          }
          if (cyl.placed) break;
        }
      }

      if (floorPacked > 0) {
        currentY += maxLength;
      }
    }

    // Aggressive gap filling for any remaining
    const unplacedCyls = allCylinders.filter(c => !c.placed);
    // Try smallest first (easier to fit in gaps)
    unplacedCyls.sort((a, b) => a.diameter - b.diameter);

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

    // One more pass with exhaustive search for any still unplaced
    const stillUnplaced = allCylinders.filter(c => !c.placed);
    for (const cyl of stillUnplaced) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
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

  /**
   * Exhaustive search - tries every position at fine granularity
   */
  private exhaustiveSearch(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;
    const step = 5; // 5cm grid

    // Floor first (z=0)
    for (let y = 0; y + length <= this.L; y += step) {
      for (let x = 0; x + diameter <= this.W; x += step) {
        const pos = { x, y, z: 0 };
        if (this.canPlace(pos, diameter, length, placed)) {
          return pos;
        }
      }
    }

    // Then try stacking
    const zLevels = new Set<number>();
    for (const box of placed) {
      zLevels.add(box.zMax);
    }

    for (const z of Array.from(zLevels).sort((a, b) => a - b)) {
      if (z + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += step) {
        for (let x = 0; x + diameter <= this.W; x += step) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placed)) {
            if (this.hasSupport(pos, diameter, length, placed)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  private packByDiameterGroups(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // Group by diameter (within 5cm tolerance)
    const groups = this.groupByDiameter(allCylinders, 5);

    // Sort groups by diameter (largest first - they need more space)
    groups.sort((a, b) => {
      const maxA = Math.max(...a.map(c => c.diameter));
      const maxB = Math.max(...b.map(c => c.diameter));
      return maxB - maxA;
    });

    // Pack each diameter group
    for (const group of groups) {
      // Sort within group by length DESC
      group.sort((a, b) => b.length - a.length);

      for (const cyl of group) {
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
    }

    // Final pass: try any remaining
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

  private groupByDiameter(cylinders: Cylinder[], tolerance: number): Cylinder[][] {
    const sorted = [...cylinders].sort((a, b) => a.diameter - b.diameter);
    const groups: Cylinder[][] = [];
    let currentGroup: Cylinder[] = [];
    let groupStart = 0;

    for (const cyl of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(cyl);
        groupStart = cyl.diameter;
      } else if (cyl.diameter - groupStart <= tolerance) {
        currentGroup.push(cyl);
      } else {
        groups.push(currentGroup);
        currentGroup = [cyl];
        groupStart = cyl.diameter;
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
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

    // Collect Y positions - include edges AND scan the full range
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placedBoxes) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
    }
    // Also scan Y at regular intervals to find gaps
    for (let y = 0; y + length <= this.L; y += Math.min(length, 50)) {
      ySet.add(y);
    }
    ySet.add(this.L - length); // Last possible position

    // Collect Z levels
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placedBoxes) {
      zSet.add(box.zMax);
    }

    const sortedY = Array.from(ySet).filter(y => y >= 0 && y + length <= this.L).sort((a, b) => a - b);
    const sortedZ = Array.from(zSet).filter(z => z >= 0 && z + diameter <= this.H).sort((a, b) => a - b);

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

    // Collect Y positions - comprehensive scanning
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placed) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
      // Also add positions just after each box
      if (box.yMax + length <= this.L) ySet.add(box.yMax);
    }
    // Fine grid scan - every 10cm to find small gaps
    for (let y = 0; y + length <= this.L; y += 10) {
      ySet.add(y);
    }
    // Also try positioning at the end
    if (this.L - length >= 0) ySet.add(this.L - length);

    const sortedY = Array.from(ySet)
      .filter(y => y >= 0 && y + length <= this.L)
      .sort((a, b) => a - b);

    // Collect Z levels
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placed) {
      zSet.add(box.zMax);
    }

    const sortedZ = Array.from(zSet)
      .filter(z => z >= 0 && z + diameter <= this.H)
      .sort((a, b) => a - b);

    // Collect X positions from existing boxes too
    const xSet = new Set<number>();
    xSet.add(0);
    for (const box of placed) {
      xSet.add(box.xMin);
      xSet.add(box.xMax);
      // Try fitting in gaps between boxes
      if (box.xMax + diameter <= this.W) xSet.add(box.xMax);
    }
    // Also scan X at intervals
    for (let x = 0; x + diameter <= this.W; x += Math.min(diameter, 20)) {
      xSet.add(x);
    }
    // And the last possible position
    if (this.W - diameter >= 0) xSet.add(this.W - diameter);

    const sortedX = Array.from(xSet)
      .filter(x => x >= 0 && x + diameter <= this.W)
      .sort((a, b) => a - b);

    // Priority: lowest Y, then lowest Z, then lowest X
    for (const y of sortedY) {
      for (const z of sortedZ) {
        for (const x of sortedX) {
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
