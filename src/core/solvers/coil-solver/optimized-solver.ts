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
      () => this.packHexagonal(all), // Hexagonal/valley nesting - most efficient
      () => this.packWithStrategy(all, 'length-groups'),
      () => this.packWithStrategy(all, 'diameter-first'),
      () => this.packWithStrategy(all, 'small-first'),
      () => this.packWithStrategy(all, 'large-first'),
      () => this.packWithStrategy(all, 'by-diameter-groups'),
      () => this.packWithStrategy(all, 'volume-desc'),
      () => this.packMixedOptimal(all),
      () => this.packLargestFirst(all),
      () => this.packByStackEfficiency(all),
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

    // Final fallback: try VERTICAL placement for any remaining unplaced
    if (bestResult!.unplaced.length > 0) {
      const stillUnplaced = all.filter(c =>
        bestResult!.unplaced.some(u => u.name === c.item.name && !c.placed)
      );

      for (const cyl of stillUnplaced) {
        if (cyl.placed) continue;

        // Try vertical placement: diameter becomes footprint, length becomes height
        const vertPos = this.findVerticalPosition(cyl, bestResult!.placedBoxes);
        if (vertPos) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
          bestResult!.placed.push(placedCyl);
          // For vertical, the box dimensions change
          bestResult!.placedBoxes.push({
            xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
            yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
            zMin: vertPos.z, zMax: vertPos.z + cyl.length,
          });
          cyl.placed = true;
        }
      }

      bestResult!.unplaced = all.filter(c => !c.placed).map(c => c.item);
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

  /**
   * Hexagonal packing - uses valley nesting for maximum density
   * Cylinders in even rows nestle into gaps between cylinders in odd rows
   */
  private packHexagonal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // Group by similar length
    const lengthGroups = this.groupByLength([...allCylinders], 10);

    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) continue;

      // Sort by diameter (largest first for floor, to create stable base)
      group.sort((a, b) => b.diameter - a.diameter);

      // Get the dominant diameter for this group
      const dominantDiameter = group.length > 0 ? group[0].diameter : 0;

      // Pack floor layer (row 0)
      let floorCylinders: PlacedBox[] = [];
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Try positions along X, spaced by diameter
        for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
          const pos = { x, y: currentY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            const box = {
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: currentY, yMax: currentY + cyl.length,
              zMin: 0, zMax: cyl.diameter,
            };
            placedBoxes.push(box);
            floorCylinders.push(box);
            break;
          }
        }
      }

      // Pack valley rows (cylinders nestle between floor cylinders)
      // For hexagonal packing, calculate exact Z positions based on geometry
      // When cylinder of radius r rests between two touching cylinders of radius r:
      // The vertical rise is r * sqrt(3) ≈ 1.732 * r from center to center
      // So bottom-to-bottom rise is r * (sqrt(3) - 1) ≈ 0.732 * r less than diameter
      const valleyRise = dominantDiameter * 0.866; // Approximate rise for each valley layer

      let rowNum = 1;
      let maxLayers = Math.ceil(this.H / valleyRise) + 1;

      while (rowNum < maxLayers && group.some(c => !c.placed)) {
        const isOffsetRow = rowNum % 2 === 1;
        // Calculate Z based on row number
        // Row 0: z = 0
        // Row 1: z = valleyRise (nestled in valley)
        // Row 2: z = 2 * valleyRise
        // etc.
        const rowZ = rowNum * valleyRise;

        if (rowZ + dominantDiameter > this.H) break;

        for (const cyl of group) {
          if (cyl.placed) continue;

          // For offset rows, start at radius offset (in the valleys)
          const xStart = isOffsetRow ? cyl.diameter / 2 : 0;

          // First try wall positions (x=0 and x=W-D) which can have wall support
          const wallPositions = [0, this.W - cyl.diameter];
          for (const x of wallPositions) {
            if (x < 0) continue;
            const pos = { x, y: currentY, z: rowZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: currentY, yMax: currentY + cyl.length,
                  zMin: rowZ, zMax: rowZ + cyl.diameter,
                });
                break;
              }
            }
          }
          if (cyl.placed) continue;

          // Then try valley positions
          for (let x = xStart; x + cyl.diameter <= this.W; x += 1) {
            const pos = { x, y: currentY, z: rowZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              // Check for support (valley or direct)
              if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: currentY, yMax: currentY + cyl.length,
                  zMin: rowZ, zMax: rowZ + cyl.diameter,
                });
                break;
              }
            }
          }
        }

        rowNum++;
      }

      // Also try direct stacking for remaining cylinders
      const zLevels = [...new Set(placedBoxes.filter(b => b.yMin === currentY).map(b => b.zMax))];
      zLevels.sort((a, b) => a - b);

      for (const z of zLevels) {
        if (z + dominantDiameter > this.H) continue;

        for (const cyl of group) {
          if (cyl.placed) continue;

          for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
            const pos = { x, y: currentY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes) &&
                this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: z, zMax: z + cyl.diameter,
              });
              break;
            }
          }
        }
      }

      currentY += maxLength;
    }

    // Final pass: exhaustive search for remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
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
   * Pack by stack efficiency - cylinders that can stack more get priority for floor positions
   * This maximizes vertical space usage
   */
  private packByStackEfficiency(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // Calculate stack potential for each cylinder (how many can stack)
    const withStackPotential = allCylinders.map(c => ({
      cyl: c,
      stackLayers: Math.floor(this.H / c.diameter),
      floorSlots: Math.floor(this.W / c.diameter),
    }));

    // Sort by: most stack layers first, then most floor slots, then longest
    withStackPotential.sort((a, b) => {
      if (b.stackLayers !== a.stackLayers) return b.stackLayers - a.stackLayers;
      if (b.floorSlots !== a.floorSlots) return b.floorSlots - a.floorSlots;
      return b.cyl.length - a.cyl.length;
    });

    // Group by similar length for efficient Y usage
    const lengthGroups = new Map<number, Cylinder[]>();
    for (const { cyl } of withStackPotential) {
      // Round length to nearest 10 for grouping
      const lengthKey = Math.round(cyl.length / 10) * 10;
      if (!lengthGroups.has(lengthKey)) lengthGroups.set(lengthKey, []);
      lengthGroups.get(lengthKey)!.push(cyl);
    }

    // Process each length group
    let currentY = 0;
    const sortedLengthKeys = Array.from(lengthGroups.keys()).sort((a, b) => b - a);

    for (const lengthKey of sortedLengthKeys) {
      const group = lengthGroups.get(lengthKey)!;
      const maxLength = Math.max(...group.map(c => c.length));

      if (currentY + maxLength > this.L) continue;

      // Sort group by diameter (smallest first - they stack better)
      group.sort((a, b) => a.diameter - b.diameter);

      // Pack this group at currentY
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Try floor first
        for (let x = 0; x + cyl.diameter <= this.W; x++) {
          const pos = { x, y: currentY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.length,
              zMin: 0, zMax: cyl.diameter,
            });
            break;
          }
        }
      }

      // Stack on floor layer
      const floorBoxes = placedBoxes.filter(b => b.yMin === currentY && b.zMin === 0);
      for (const cyl of group.filter(c => !c.placed)) {
        for (const support of floorBoxes) {
          const z = support.zMax;
          if (z + cyl.diameter > this.H) continue;

          for (let x = Math.max(0, support.xMin - cyl.diameter / 2); x + cyl.diameter <= this.W; x++) {
            const pos = { x, y: currentY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes) &&
                this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
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

      // Third and fourth layers
      for (let layer = 2; layer <= 3; layer++) {
        const prevLayerBoxes = placedBoxes.filter(b =>
          b.yMin === currentY && b.zMin > 0 && b.zMax <= this.H * layer / 4
        );
        for (const cyl of group.filter(c => !c.placed)) {
          for (const support of prevLayerBoxes) {
            const z = support.zMax;
            if (z + cyl.diameter > this.H) continue;

            for (let x = Math.max(0, support.xMin - cyl.diameter / 2); x + cyl.diameter <= this.W; x++) {
              const pos = { x, y: currentY, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes) &&
                  this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
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
      }

      currentY += maxLength;
    }

    // Final exhaustive search for remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
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
   * Pack largest diameter cylinders first - they need the best positions
   */
  private packLargestFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // Sort by diameter DESC, then by length DESC
    const sorted = [...allCylinders].sort((a, b) => {
      if (b.diameter !== a.diameter) return b.diameter - a.diameter;
      return b.length - a.length;
    });

    // First pass: place all on floor with optimal spacing
    for (const cyl of sorted) {
      if (cyl.placed) continue;

      // Find best floor position
      let bestPos: { x: number; y: number; z: number } | null = null;
      let bestScore = -Infinity;

      // Try positions along Y, preferring front of container
      for (let y = 0; y + cyl.length <= this.L; y += 5) {
        for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
          const pos = { x, y, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            // Score: prefer lower Y, lower X
            const score = -y * 1000 - x;
            if (score > bestScore) {
              bestScore = score;
              bestPos = pos;
            }
          }
        }
        if (bestPos) break; // Found position at this Y, use it
      }

      if (bestPos) {
        const placedCyl = this.createPlacedCylinder(cyl, bestPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: bestPos.x, xMax: bestPos.x + cyl.diameter,
          yMin: bestPos.y, yMax: bestPos.y + cyl.length,
          zMin: 0, zMax: cyl.diameter,
        });
      }
    }

    // Second pass: stack remaining (smallest first for stability)
    const unplacedForStack = sorted.filter(c => !c.placed).sort((a, b) => a.diameter - b.diameter);

    for (const cyl of unplacedForStack) {
      // Find stacking position
      const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);

      for (const z of zLevels) {
        if (z + cyl.diameter > this.H) continue;

        let found = false;
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 1) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.length,
                  zMin: pos.z, zMax: pos.z + cyl.diameter,
                });
                found = true;
              }
            }
          }
        }
        if (found) break;
      }
    }

    // Final pass: exhaustive search for remaining
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

    // Try multiple grid sizes, from coarse to fine
    for (const step of [10, 5, 2, 1]) {
      // Floor first (z=0)
      for (let y = 0; y + length <= this.L; y += step) {
        for (let x = 0; x + diameter <= this.W; x += step) {
          const pos = { x, y, z: 0 };
          if (this.canPlace(pos, diameter, length, placed)) {
            return pos;
          }
        }
      }

      // Then try stacking at known Z levels
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

      // Also try arbitrary Z positions (scan full height)
      for (let z = 1; z + diameter <= this.H; z += step) {
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
    const radius = diameter / 2;

    // Check container bounds
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    // Center of new cylinder in XZ plane
    const cx = x + radius;
    const cz = z + radius;

    // Check collision with each placed cylinder using circular cross-section
    for (const box of placed) {
      // First check Y overlap (bounding box style - cylinders along Y)
      if (y >= box.yMax || y + length <= box.yMin) {
        continue; // No Y overlap, no collision possible
      }

      // Y overlaps, now check XZ circular collision
      const otherRadius = (box.xMax - box.xMin) / 2;
      const otherCx = box.xMin + otherRadius;
      const otherCz = box.zMin + otherRadius;

      const dx = cx - otherCx;
      const dz = cz - otherCz;
      const distSq = dx * dx + dz * dz;
      const minDist = radius + otherRadius - 1; // 1cm tolerance for touching

      if (distSq < minDist * minDist) {
        return false; // Circular cross-sections overlap
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
    const radius = diameter / 2;
    const cx = x + radius;
    const cz = z + radius; // Center Z of new cylinder

    // Check for support from cylinders below
    // Support can come from:
    // 1. Single cylinder directly below (stacking on top)
    // 2. Two cylinders forming a valley (cylinder rests in the gap)

    const supportCandidates: PlacedBox[] = [];

    for (const box of placed) {
      // Check Y overlap (must overlap in length direction)
      if (y >= box.yMax || y + length <= box.yMin) continue;

      // For support, the supporting cylinder must be below us
      // Its top (zMax) should be at or below our center Z
      if (box.zMax > cz + 5) continue; // Support is too high
      if (box.zMax < z - 5) continue; // Support is too low (our bottom is above their top)

      supportCandidates.push(box);
    }

    // Check for direct stacking support (cylinder sits on top of another)
    for (const box of supportCandidates) {
      // Direct support: our bottom (z) is near their top (zMax)
      if (Math.abs(box.zMax - z) <= 5) {
        const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
        if (xOverlap >= diameter * 0.3) {
          return true;
        }
      }
    }

    // Check for valley support (resting between two cylinders)
    // For valley support, our center Z should be BELOW the tops of support cylinders
    // because we nestle down between them
    for (let i = 0; i < supportCandidates.length; i++) {
      for (let j = i + 1; j < supportCandidates.length; j++) {
        const box1 = supportCandidates[i];
        const box2 = supportCandidates[j];

        const r1 = (box1.xMax - box1.xMin) / 2;
        const r2 = (box2.xMax - box2.xMin) / 2;
        const cx1 = box1.xMin + r1;
        const cx2 = box2.xMin + r2;
        const cz1 = box1.zMin + r1;
        const cz2 = box2.zMin + r2;

        // Check if the two support cylinders are at similar height
        if (Math.abs(cz1 - cz2) > 10) continue;

        // Distance between support cylinder centers in X
        const dxSupport = Math.abs(cx2 - cx1);

        // For valley nesting, support cylinders should be close enough
        // that the new cylinder can touch both
        // Max gap where new cylinder can still touch both: 2 * (r1 + radius) for same-size
        if (dxSupport > r1 + r2 + diameter) continue;

        // Check if new cylinder center is positioned to rest in valley
        const minCx = Math.min(cx1, cx2);
        const maxCx = Math.max(cx1, cx2);

        // New cylinder center should be between the two support centers
        if (cx >= minCx - radius * 0.5 && cx <= maxCx + radius * 0.5) {
          // Verify geometry: calculate expected Z for valley nesting
          // When resting in valley between two cylinders, the geometry gives:
          // cz = cz_support + sqrt((r + r_support)^2 - (dx/2)^2)
          // where dx is the horizontal distance between support centers

          const avgSupportCz = (cz1 + cz2) / 2;
          const avgSupportR = (r1 + r2) / 2;
          const halfGap = dxSupport / 2;
          const sumRadii = radius + avgSupportR;

          if (sumRadii > halfGap) {
            const expectedCz = avgSupportCz + Math.sqrt(sumRadii * sumRadii - halfGap * halfGap);
            // Allow some tolerance in Z position
            if (Math.abs(cz - expectedCz) < radius * 0.5) {
              return true;
            }
            // Also accept if we're just resting on top of the valley
            if (cz >= avgSupportCz && cz <= expectedCz + radius * 0.3) {
              return true;
            }
          }
        }
      }
    }

    // Also check for wall support (cylinder against container wall)
    // Wall acts as one side of a "valley", so we only need ONE support cylinder
    if (x <= 5 || x + diameter >= this.W - 5) {
      for (const box of placed) {
        // Check Y overlap
        if (y >= box.yMax || y + length <= box.yMin) continue;

        // Check if support is below us (their top is below our center)
        if (box.zMax > cz + 5) continue;
        if (box.zMax < 0) continue;

        const boxR = (box.xMax - box.xMin) / 2;
        const boxCx = box.xMin + boxR;
        const boxCz = box.zMin + boxR;

        // Check X overlap or proximity
        const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
        if (xOverlap < 0) continue;

        // For wall support, calculate if the geometry works
        // Wall + one cylinder can support another cylinder in a valley-like configuration
        const dx = Math.abs(cx - boxCx);
        const sumRadii = radius + boxR;

        if (dx < sumRadii + 10) { // Close enough horizontally
          // Calculate expected Z for resting against wall + one cylinder
          // This is similar to valley but with wall as virtual cylinder
          const wallCx = x <= 5 ? 0 : this.W; // Virtual wall cylinder center
          const dxToWall = Math.abs(cx - wallCx);

          if (dxToWall < radius + 5) { // Touching wall
            // Check if Z position is reasonable for support
            if (cz > boxCz && cz < boxCz + sumRadii + 10) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }


  /**
   * Find position for vertical cylinder placement
   * Vertical: diameter is footprint (X, Y), length is height (Z)
   */
  private findVerticalPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    // Check if vertical placement is even possible
    if (diameter > this.W || diameter > this.L || length > this.H) {
      return null;
    }

    // For vertical placement, scan floor positions
    // The cylinder needs diameter x diameter footprint
    for (let y = 0; y + diameter <= this.L; y += 5) {
      for (let x = 0; x + diameter <= this.W; x += 5) {
        const pos = { x, y, z: 0 };
        if (this.canPlaceVertical(pos, diameter, length, placed)) {
          return pos;
        }
      }
    }

    // Try stacking vertically on top of other vertical cylinders
    const zLevels = [...new Set(placed.map(b => b.zMax))].filter(z => z + length <= this.H);
    zLevels.sort((a, b) => a - b);

    for (const z of zLevels) {
      for (let y = 0; y + diameter <= this.L; y += 5) {
        for (let x = 0; x + diameter <= this.W; x += 5) {
          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            // Check for support (need something below)
            if (this.hasVerticalSupport(pos, diameter, placed)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if vertical cylinder can be placed (no collision)
   */
  private canPlaceVertical(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;

    // Check bounds (for vertical: diameter is X/Y footprint, length is height Z)
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + diameter > this.L) return false;
    if (z < 0 || z + length > this.H) return false;

    // Center of vertical cylinder in XY plane
    const cx = x + radius;
    const cy = y + radius;

    for (const box of placed) {
      // Check Z overlap first
      if (z >= box.zMax || z + length <= box.zMin) {
        continue;
      }

      // Z overlaps - check XY collision
      const otherW = box.xMax - box.xMin;
      const otherL = box.yMax - box.yMin;

      // If the other box is roughly square (another vertical cylinder)
      if (Math.abs(otherW - otherL) < 5) {
        // Circular collision in XY
        const otherR = otherW / 2;
        const otherCx = box.xMin + otherR;
        const otherCy = box.yMin + otherR;

        const dx = cx - otherCx;
        const dy = cy - otherCy;
        const distSq = dx * dx + dy * dy;
        const minDist = radius + otherR - 1;

        if (distSq < minDist * minDist) {
          return false;
        }
      } else {
        // Box collision (horizontal cylinder or other shape)
        if (x < box.xMax && x + diameter > box.xMin &&
            y < box.yMax && y + diameter > box.yMin) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if vertical cylinder has support below
   */
  private hasVerticalSupport(
    pos: { x: number; y: number; z: number },
    diameter: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      if (Math.abs(box.zMax - z) <= 2) {
        // Check XY overlap
        const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
        const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

        if (xOverlap > diameter * 0.3 && yOverlap > diameter * 0.3) {
          return true;
        }
      }
    }

    return false;
  }

  /**
   * Create a placed cylinder in vertical orientation
   */
  private createVerticalPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + radius,
        y: pos.y + radius,
        z: pos.z + cyl.length / 2,
      },
      radius,
      length: cyl.length,
      orientation: 'vertical',
      rotation: ORIENTATION_ROTATIONS['vertical'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
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
