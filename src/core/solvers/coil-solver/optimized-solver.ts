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
      () => this.packDifficultFirst(all), // Place large-diameter cylinders first (vertical)
      () => this.packMixedOrientations(all), // TRUE mixed orientation - tries both for each cylinder
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
      () => this.packCompact(all), // NEW: Compact packing focusing on floor utilization
      () => this.packVerticalPriority(all), // NEW: Prioritize vertical for short rolls
      () => this.packMaximizeStacking(all), // Maximize vertical stacking to save Y space
      () => this.packTightLayers(all), // Fill each Y slice completely before moving
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      // Reset placed flags
      all.forEach(c => c.placed = false);
      const result = strategy();

      // Track boxes for potential further optimization
      // IMPORTANT: Handle orientation correctly!
      const placedBoxes: PlacedBox[] = result.placed.map(p => {
        const isVertical = p.orientation === 'vertical';
        if (isVertical) {
          // Vertical: diameter in X and Y, length in Z
          return {
            xMin: p.position.x, xMax: p.position.x + p.radius * 2,
            yMin: p.position.y, yMax: p.position.y + p.radius * 2,
            zMin: p.position.z, zMax: p.position.z + p.length,
          };
        } else {
          // Horizontal: diameter in X and Z, length in Y
          return {
            xMin: p.position.x, xMax: p.position.x + p.radius * 2,
            yMin: p.position.y, yMax: p.position.y + p.length,
            zMin: p.position.z, zMax: p.position.z + p.radius * 2,
          };
        }
      });

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
      // Find all unplaced cylinders by checking placed status
      const stillUnplaced = all.filter(c => !c.placed);

      // Sort by smallest diameter first (easier to fit)
      stillUnplaced.sort((a, b) => a.diameter - b.diameter);

      console.log(`Trying vertical placement for ${stillUnplaced.length} unplaced cylinders`);

      for (const cyl of stillUnplaced) {
        // Check if vertical placement is even possible (length must fit in height)
        if (cyl.length > this.H) {
          console.log(`  ${cyl.item.name} D${cyl.diameter} L${cyl.length}: too tall for vertical (H=${this.H})`);
          continue;
        }

        // Try vertical placement: diameter becomes footprint, length becomes height
        const vertPos = this.findVerticalPosition(cyl, bestResult!.placedBoxes);
        if (vertPos) {
          console.log(`  ${cyl.item.name} D${cyl.diameter} L${cyl.length}: placed VERTICAL at (${vertPos.x}, ${vertPos.y}, ${vertPos.z})`);
          const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
          bestResult!.placed.push(placedCyl);
          // For vertical, the box dimensions change
          bestResult!.placedBoxes.push({
            xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
            yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
            zMin: vertPos.z, zMax: vertPos.z + cyl.length,
          });
          cyl.placed = true;
        } else {
          console.log(`  ${cyl.item.name} D${cyl.diameter} L${cyl.length}: could not find vertical position`);
        }
      }

      bestResult!.unplaced = all.filter(c => !c.placed).map(c => c.item);
    }

    // SUPER-FINAL: If still unplaced, try aggressive placement with step=1 on all Z levels
    if (bestResult!.unplaced.length > 0) {
      const superFinalUnplaced = all.filter(c => !c.placed);
      console.log(`Super-final aggressive pass for ${superFinalUnplaced.length} unplaced cylinders`);

      for (const cyl of superFinalUnplaced) {
        const result = this.tryAggressivePlacement(cyl, bestResult!.placedBoxes);
        if (result) {
          console.log(`  ${cyl.item.name} D${cyl.diameter}: AGGRESSIVE ${result.orientation.toUpperCase()} at (${result.pos.x}, ${result.pos.y}, ${result.pos.z})`);

          if (result.orientation === 'horizontal-y') {
            const placedCyl = this.createPlacedCylinder(cyl, result.pos);
            bestResult!.placed.push(placedCyl);
            bestResult!.placedBoxes.push({
              xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
              yMin: result.pos.y, yMax: result.pos.y + cyl.length,
              zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
            });
          } else if (result.orientation === 'vertical') {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, result.pos);
            bestResult!.placed.push(placedCyl);
            bestResult!.placedBoxes.push({
              xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
              yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
              zMin: result.pos.z, zMax: result.pos.z + cyl.length,
            });
          } else {
            const placedCyl = this.createRotatedPlacedCylinder(cyl, result.pos);
            bestResult!.placed.push(placedCyl);
            bestResult!.placedBoxes.push({
              xMin: result.pos.x, xMax: result.pos.x + cyl.length,
              yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
              zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
            });
          }
          cyl.placed = true;
        } else {
          console.log(`  ${cyl.item.name} D${cyl.diameter}: AGGRESSIVE FAILED`);
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

    console.log(`=== HEXAGONAL PACKING ===`);

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
      console.log(`  Group at Y=${currentY}: ${group.length} cylinders, maxLen=${maxLength}, domD=${dominantDiameter}`);

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
        // Calculate base Z for this row (actual position depends on supports)
        const baseRowZ = rowNum * valleyRise;

        if (baseRowZ + dominantDiameter > this.H) break;

        for (const cyl of group) {
          if (cyl.placed) continue;

          // For offset rows, start at radius offset (in the valleys)
          const xStart = isOffsetRow ? cyl.diameter / 2 : 0;

          // First try wall positions (x=0 and x=W-D) which can have wall support
          const wallPositions = [0, this.W - cyl.diameter];
          for (const x of wallPositions) {
            if (x < 0) continue;

            // Find the actual Z position where this cylinder would rest
            const supportedZ = this.findSupportedZ(x, currentY, cyl, placedBoxes);
            if (supportedZ === null) continue;
            if (supportedZ + cyl.diameter > this.H) continue;

            const pos = { x, y: currentY, z: supportedZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: supportedZ, zMax: supportedZ + cyl.diameter,
              });
              console.log(`    Placed D${cyl.diameter} at x=${x}, z=${supportedZ} (wall)`);
              break;
            }
          }
          if (cyl.placed) continue;

          // Then try valley positions
          for (let x = xStart; x + cyl.diameter <= this.W; x += 1) {
            // Find the actual Z position where this cylinder would rest
            const supportedZ = this.findSupportedZ(x, currentY, cyl, placedBoxes);
            if (supportedZ === null) continue;
            if (supportedZ + cyl.diameter > this.H) continue;

            const pos = { x, y: currentY, z: supportedZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: supportedZ, zMax: supportedZ + cyl.diameter,
              });
              console.log(`    Placed D${cyl.diameter} at x=${x}, z=${supportedZ} (valley)`);
              break;
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

  /**
   * TRUE mixed orientation packing - tries BOTH horizontal and vertical for each cylinder
   * Decides dynamically which orientation works best
   */
  private packMixedOrientations(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== MIXED ORIENTATION PACKING ===`);

    // Sort by volume (largest first) - big items need priority for good positions
    const sorted = [...allCylinders].sort((a, b) => {
      const volA = Math.PI * (a.diameter / 2) ** 2 * a.length;
      const volB = Math.PI * (b.diameter / 2) ** 2 * b.length;
      return volB - volA;
    });

    // First pass: place each cylinder trying BOTH orientations
    for (const cyl of sorted) {
      if (cyl.placed) continue;

      // Try horizontal placement
      const horizPos = this.findBestHorizontalPosition(cyl, placedBoxes);

      // Try vertical placement (if length fits in height)
      const vertPos = cyl.length <= this.H ? this.findVerticalPosition(cyl, placedBoxes) : null;

      // Decide which orientation to use
      // Prefer horizontal if both work (more stable), but use vertical if horizontal doesn't fit
      if (horizPos && vertPos) {
        // Both work - prefer horizontal for stability, but consider space efficiency
        // Use horizontal unless vertical leaves more useful space
        const placedCyl = this.createPlacedCylinder(cyl, horizPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: horizPos.x, xMax: horizPos.x + cyl.diameter,
          yMin: horizPos.y, yMax: horizPos.y + cyl.length,
          zMin: horizPos.z, zMax: horizPos.z + cyl.diameter,
        });
        console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL at (${horizPos.x}, ${horizPos.y}, ${horizPos.z})`);
      } else if (horizPos) {
        // Only horizontal works
        const placedCyl = this.createPlacedCylinder(cyl, horizPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: horizPos.x, xMax: horizPos.x + cyl.diameter,
          yMin: horizPos.y, yMax: horizPos.y + cyl.length,
          zMin: horizPos.z, zMax: horizPos.z + cyl.diameter,
        });
        console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL at (${horizPos.x}, ${horizPos.y}, ${horizPos.z})`);
      } else if (vertPos) {
        // Only vertical works
        const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
          yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
          zMin: vertPos.z, zMax: vertPos.z + cyl.length,
        });
        console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL at (${vertPos.x}, ${vertPos.y}, ${vertPos.z})`);
      } else {
        console.log(`  ${cyl.item.name} D${cyl.diameter}: NO POSITION FOUND (will retry)`);
      }
    }

    // Second pass: try harder for unplaced - maybe previous placements opened up space
    const unplacedCyls = sorted.filter(c => !c.placed);
    console.log(`  Second pass: ${unplacedCyls.length} unplaced cylinders`);

    for (const cyl of unplacedCyls) {
      // Try exhaustive horizontal search
      const horizPos = this.exhaustiveSearch(cyl, placedBoxes);
      if (horizPos) {
        const placedCyl = this.createPlacedCylinder(cyl, horizPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: horizPos.x, xMax: horizPos.x + cyl.diameter,
          yMin: horizPos.y, yMax: horizPos.y + cyl.length,
          zMin: horizPos.z, zMax: horizPos.z + cyl.diameter,
        });
        console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL (exhaustive) at (${horizPos.x}, ${horizPos.y}, ${horizPos.z})`);
        continue;
      }

      // Try vertical with exhaustive search
      if (cyl.length <= this.H) {
        const vertPos = this.findVerticalPosition(cyl, placedBoxes);
        if (vertPos) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
            yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
            zMin: vertPos.z, zMax: vertPos.z + cyl.length,
          });
          console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL (retry) at (${vertPos.x}, ${vertPos.y}, ${vertPos.z})`);
          continue;
        }
      }
    }

    // Third pass: try placing horizontal ON TOP of verticals
    const stillUnplaced = sorted.filter(c => !c.placed);
    console.log(`  Third pass: ${stillUnplaced.length} still unplaced`);

    for (const cyl of stillUnplaced) {
      // Find vertical cylinders that could support a horizontal cylinder
      const verticalBoxes = placedBoxes.filter(b => {
        const boxW = b.xMax - b.xMin;
        const boxL = b.yMax - b.yMin;
        return Math.abs(boxW - boxL) < 10; // Square-ish = vertical
      });

      for (const vBox of verticalBoxes) {
        const z = vBox.zMax;
        if (z + cyl.diameter > this.H) continue;

        // Try placing horizontal cylinder on top of vertical
        // Try ALL X positions that could overlap with this vertical
        for (let y = 0; y + cyl.length <= this.L && !cyl.placed; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !cyl.placed; x += 5) {
            const pos = { x, y, z };

            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              // Check if this position has sufficient support from ANY vertical cylinder at this Z
              if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.length,
                  zMin: pos.z, zMax: pos.z + cyl.diameter,
                });
                console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL on VERTICAL at (${pos.x}, ${pos.y}, ${pos.z})`);
              }
            }
          }
        }
        if (cyl.placed) break;
      }
    }

    // Final pass: try ANY valid position with fine grid
    const finalUnplaced = sorted.filter(c => !c.placed);
    console.log(`  Final pass: ${finalUnplaced.length} remaining`);

    for (const cyl of finalUnplaced) {
      // Exhaustive fine-grid search for both orientations
      let found = false;

      // Try every possible horizontal position
      for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.length,
                  zMin: pos.z, zMax: pos.z + cyl.diameter,
                });
                console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL (final) at (${pos.x}, ${pos.y}, ${pos.z})`);
                found = true;
              }
            }
          }
        }
      }

      // Try every possible vertical position
      if (!found && cyl.length <= this.H) {
        for (let z = 0; z + cyl.length <= this.H && !found; z += 5) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                  const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: pos.x, xMax: pos.x + cyl.diameter,
                    yMin: pos.y, yMax: pos.y + cyl.diameter,
                    zMin: pos.z, zMax: pos.z + cyl.length,
                  });
                  console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL (final) at (${pos.x}, ${pos.y}, ${pos.z})`);
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    // ULTRA-FINAL pass: exhaustive search at ALL Z levels including floor
    const ultraFinalUnplaced = sorted.filter(c => !c.placed);
    if (ultraFinalUnplaced.length > 0) {
      console.log(`  Ultra-final pass: ${ultraFinalUnplaced.length} remaining`);

      // Get ALL unique Z levels - floor (0) + all cylinder tops
      const allZLevels: number[] = [0]; // ALWAYS include floor!
      for (const box of placedBoxes) {
        if (!allZLevels.includes(box.zMax)) {
          allZLevels.push(box.zMax);
        }
      }
      allZLevels.sort((a, b) => a - b);
      console.log(`    All Z levels to try: ${allZLevels.join(', ')}`);

      for (const cyl of ultraFinalUnplaced) {
        let found = false;

        // FIRST: Try floor level (z=0) with fine grid - this is most important!
        console.log(`    Searching floor positions for D${cyl.diameter}...`);
        for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL (floor) at (${pos.x}, ${pos.y}, 0)`);
              found = true;
            }
          }
        }

        // SECOND: Try vertical at floor level
        if (!found && cyl.length <= this.H) {
          console.log(`    Searching vertical floor positions for D${cyl.diameter}...`);
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL (floor) at (${pos.x}, ${pos.y}, 0)`);
                found = true;
              }
            }
          }
        }

        // THIRD: Try rotated horizontal (length along X instead of Y) at floor
        if (!found && cyl.length <= this.W) {
          console.log(`    Searching rotated horizontal for D${cyl.diameter}...`);
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              // For rotated: length is along X, diameter is along Y
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.length,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.diameter,
                });
                console.log(`  ${cyl.item.name} D${cyl.diameter}: ROTATED HORIZONTAL at (${pos.x}, ${pos.y}, 0)`);
                found = true;
              }
            }
          }
        }

        // FOURTH: Try stacking at other Z levels
        if (!found) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue; // Already tried floor
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
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
                    console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL (stacked) at (${pos.x}, ${pos.y}, ${pos.z})`);
                    found = true;
                  }
                }
              }
            }
          }
        }

        // FIFTH: Try vertical stacking
        if (!found && cyl.length <= this.H) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue;
            if (z + cyl.length > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                    const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.diameter,
                      zMin: pos.z, zMax: pos.z + cyl.length,
                    });
                    console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL (stacked) at (${pos.x}, ${pos.y}, ${pos.z})`);
                    found = true;
                  }
                }
              }
            }
          }
        }

        if (!found) {
          console.log(`    FAILED to place ${cyl.item.name} D${cyl.diameter}x${cyl.length}`);
        }
      }
    }

    // MEGA-FINAL pass: step=1 precision search for any remaining
    const megaFinalUnplaced = sorted.filter(c => !c.placed);
    if (megaFinalUnplaced.length > 0) {
      console.log(`  Mega-final pass (step=1): ${megaFinalUnplaced.length} remaining`);

      // Recompute Z levels
      const finalZLevels: number[] = [0];
      for (const box of placedBoxes) {
        if (!finalZLevels.includes(box.zMax)) {
          finalZLevels.push(box.zMax);
        }
      }
      finalZLevels.sort((a, b) => a - b);

      for (const cyl of megaFinalUnplaced) {
        const foundPos = this.findAnyValidPosition(cyl, placedBoxes, finalZLevels);
        if (foundPos) {
          if (foundPos.orientation === 'horizontal-y') {
            const placedCyl = this.createPlacedCylinder(cyl, foundPos.pos);
            placed.push(placedCyl);
            placedBoxes.push({
              xMin: foundPos.pos.x, xMax: foundPos.pos.x + cyl.diameter,
              yMin: foundPos.pos.y, yMax: foundPos.pos.y + cyl.length,
              zMin: foundPos.pos.z, zMax: foundPos.pos.z + cyl.diameter,
            });
          } else if (foundPos.orientation === 'vertical') {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, foundPos.pos);
            placed.push(placedCyl);
            placedBoxes.push({
              xMin: foundPos.pos.x, xMax: foundPos.pos.x + cyl.diameter,
              yMin: foundPos.pos.y, yMax: foundPos.pos.y + cyl.diameter,
              zMin: foundPos.pos.z, zMax: foundPos.pos.z + cyl.length,
            });
          } else {
            const placedCyl = this.createRotatedPlacedCylinder(cyl, foundPos.pos);
            placed.push(placedCyl);
            placedBoxes.push({
              xMin: foundPos.pos.x, xMax: foundPos.pos.x + cyl.length,
              yMin: foundPos.pos.y, yMax: foundPos.pos.y + cyl.diameter,
              zMin: foundPos.pos.z, zMax: foundPos.pos.z + cyl.diameter,
            });
          }
          cyl.placed = true;
          console.log(`  ${cyl.item.name} D${cyl.diameter}: ${foundPos.orientation.toUpperCase()} at (${foundPos.pos.x}, ${foundPos.pos.y}, ${foundPos.pos.z})`);
        }
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    console.log(`  Mixed orientation result: ${placed.length} placed, ${unplaced.length} unplaced`);
    return { placed, unplaced };
  }

  /**
   * Place "difficult" cylinders first - large diameter ones that need vertical placement
   * Then pack the rest around them
   */
  private packDifficultFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== DIFFICULT FIRST PACKING ===`);

    // Identify "difficult" cylinders: large diameter relative to container width
    // These are best placed vertically to save horizontal space
    const difficult: Cylinder[] = [];
    const easy: Cylinder[] = [];

    for (const cyl of allCylinders) {
      // Cylinder is "difficult" if:
      // 1. Diameter is large (> 80% of container width / 2) OR
      // 2. Length is short enough for vertical (length <= H) AND diameter is > 90
      const isDifficult = cyl.diameter > 90 || (cyl.length <= this.H && cyl.diameter > this.W / 3);
      if (isDifficult) {
        difficult.push(cyl);
      } else {
        easy.push(cyl);
      }
    }

    console.log(`  Difficult cylinders: ${difficult.length}, Easy: ${easy.length}`);

    // Sort difficult by diameter DESC (place largest first)
    difficult.sort((a, b) => b.diameter - a.diameter);

    // Place difficult cylinders FIRST - try vertical at back of container
    for (const cyl of difficult) {
      let placed_cyl = false;

      // Try vertical placement first (at back of container - high Y)
      if (cyl.length <= this.H) {
        // Start from back of container
        for (let y = this.L - cyl.diameter; y >= 0 && !placed_cyl; y -= 10) {
          for (let x = 0; x + cyl.diameter <= this.W && !placed_cyl; x += 10) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              console.log(`  DIFFICULT ${cyl.item.name} D${cyl.diameter}: VERTICAL at (${pos.x}, ${pos.y}, 0)`);
              placed_cyl = true;
            }
          }
        }
      }

      // If vertical didn't work, try horizontal
      if (!placed_cyl) {
        for (let y = 0; y + cyl.length <= this.L && !placed_cyl; y += 10) {
          for (let x = 0; x + cyl.diameter <= this.W && !placed_cyl; x += 10) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              console.log(`  DIFFICULT ${cyl.item.name} D${cyl.diameter}: HORIZONTAL at (${pos.x}, ${pos.y}, 0)`);
              placed_cyl = true;
            }
          }
        }
      }
    }

    // Now pack easy cylinders using hexagonal packing
    // Sort by length (group similar lengths)
    easy.sort((a, b) => a.length - b.length);

    // Group by similar length
    const lengthGroups = this.groupByLength(easy, 15);
    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) continue;

      // Sort by diameter DESC for floor stability
      group.sort((a, b) => b.diameter - a.diameter);

      // Pack floor layer
      for (const cyl of group) {
        if (cyl.placed) continue;

        for (let x = 0; x + cyl.diameter <= this.W; x += 5) {
          const pos = { x, y: currentY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCylinder = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCylinder);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: currentY, yMax: currentY + cyl.length,
              zMin: 0, zMax: cyl.diameter,
            });
            break;
          }
        }
      }

      // Stack on floor layer
      const dominantDiameter = group.length > 0 ? group[0].diameter : 60;
      const valleyRise = dominantDiameter * 0.866;

      for (let layer = 1; layer <= 4; layer++) {
        const layerZ = layer * valleyRise;
        if (layerZ + dominantDiameter > this.H) break;

        for (const cyl of group) {
          if (cyl.placed) continue;

          const xOffset = (layer % 2 === 1) ? cyl.diameter / 2 : 0;
          for (let x = xOffset; x + cyl.diameter <= this.W; x += 5) {
            const supportedZ = this.findSupportedZ(x, currentY, cyl, placedBoxes);
            if (supportedZ === null || supportedZ + cyl.diameter > this.H) continue;

            const pos = { x, y: currentY, z: supportedZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: supportedZ, zMax: supportedZ + cyl.diameter,
              });
              break;
            }
          }
        }
      }

      currentY += maxLength;
    }

    // Final pass: exhaustive search for any remaining
    const remaining = allCylinders.filter(c => !c.placed);
    console.log(`  Remaining after main packing: ${remaining.length}`);

    for (const cyl of remaining) {
      // Try horizontal exhaustive
      let found = false;
      for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCylinder = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCylinder);
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
      }

      // Try vertical exhaustive
      if (!found && cyl.length <= this.H) {
        for (let z = 0; z + cyl.length <= this.H && !found; z += 5) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                  const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCylinder);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: pos.x, xMax: pos.x + cyl.diameter,
                    yMin: pos.y, yMax: pos.y + cyl.diameter,
                    zMin: pos.z, zMax: pos.z + cyl.length,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    // ULTRA-FINAL: exhaustive search at ALL Z levels including floor
    const ultraRemaining = allCylinders.filter(c => !c.placed);
    if (ultraRemaining.length > 0) {
      console.log(`  Ultra-final pass: ${ultraRemaining.length} remaining`);

      // Include floor (0) and all cylinder tops
      const allZLevels: number[] = [0];
      for (const box of placedBoxes) {
        if (!allZLevels.includes(box.zMax)) {
          allZLevels.push(box.zMax);
        }
      }
      allZLevels.sort((a, b) => a - b);

      for (const cyl of ultraRemaining) {
        let found = false;

        // FIRST: Try floor level horizontal
        for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL (floor) at (${pos.x}, ${pos.y}, 0)`);
              found = true;
            }
          }
        }

        // SECOND: Try floor level vertical
        if (!found && cyl.length <= this.H) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCylinder);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL (floor) at (${pos.x}, ${pos.y}, 0)`);
                found = true;
              }
            }
          }
        }

        // THIRD: Try rotated horizontal at floor
        if (!found && cyl.length <= this.W) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCylinder = this.createRotatedPlacedCylinder(cyl, pos);
                placed.push(placedCylinder);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.length,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.diameter,
                });
                console.log(`  ${cyl.item.name} D${cyl.diameter}: ROTATED HORIZONTAL at (${pos.x}, ${pos.y}, 0)`);
                found = true;
              }
            }
          }
        }

        // FOURTH: Try stacking at other Z levels
        if (!found) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCylinder = this.createPlacedCylinder(cyl, pos);
                    placed.push(placedCylinder);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.length,
                      zMin: pos.z, zMax: pos.z + cyl.diameter,
                    });
                    console.log(`  ${cyl.item.name} D${cyl.diameter}: HORIZONTAL (stacked) at (${pos.x}, ${pos.y}, ${pos.z})`);
                    found = true;
                  }
                }
              }
            }
          }
        }

        // FIFTH: Try vertical stacking
        if (!found && cyl.length <= this.H) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue;
            if (z + cyl.length > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                    const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(placedCylinder);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.diameter,
                      zMin: pos.z, zMax: pos.z + cyl.length,
                    });
                    console.log(`  ${cyl.item.name} D${cyl.diameter}: VERTICAL (stacked) at (${pos.x}, ${pos.y}, ${pos.z})`);
                    found = true;
                  }
                }
              }
            }
          }
        }

        if (!found) {
          console.log(`    FAILED to place ${cyl.item.name} D${cyl.diameter}x${cyl.length}`);
        }
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    console.log(`  Difficult-first result: ${placed.length} placed, ${unplaced.length} unplaced`);
    return { placed, unplaced };
  }

  /**
   * Find best horizontal position for a cylinder
   */
  private findBestHorizontalPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Try floor first (z=0)
    for (let y = 0; y + length <= this.L; y += 5) {
      for (let x = 0; x + diameter <= this.W; x += 5) {
        const pos = { x, y, z: 0 };
        if (this.canPlace(pos, diameter, length, placedBoxes)) {
          return pos;
        }
      }
    }

    // Try stacking positions
    const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);
    for (const z of zLevels) {
      if (z + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += 5) {
        for (let x = 0; x + diameter <= this.W; x += 5) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (this.hasSupport(pos, diameter, length, placedBoxes)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
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
   * Compact packing - focuses on maximizing floor utilization before stacking
   * Places cylinders in tight rows, exploiting container width efficiently
   */
  private packCompact(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== COMPACT PACKING ===`);

    // Sort by length DESC to maximize Y usage per row
    const sorted = [...allCylinders].sort((a, b) => b.length - a.length);

    // Group by similar length (within 5cm)
    const lengthGroups = this.groupByLength(sorted, 5);

    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) continue;

      // Sort group by diameter DESC for better floor packing
      group.sort((a, b) => b.diameter - a.diameter);

      // Calculate how many rows can fit in XZ
      const dominantDiameter = group[0]?.diameter || 80;
      const rowsX = Math.floor(this.W / dominantDiameter);
      const rowsZ = Math.floor(this.H / dominantDiameter);
      console.log(`  Group at Y=${currentY}: ${group.length} cylinders, maxLen=${maxLength}, rows=${rowsX}x${rowsZ}`);

      // Pack floor layer - fill entire width
      let floorX = 0;
      for (const cyl of group) {
        if (cyl.placed) continue;
        if (floorX + cyl.diameter > this.W) break; // Row full

        const pos = { x: floorX, y: currentY, z: 0 };
        if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: currentY, yMax: currentY + cyl.length,
            zMin: 0, zMax: cyl.diameter,
          });
          floorX += cyl.diameter;
        }
      }

      // Stack second and third layers using valley nesting
      for (let layer = 1; layer <= 3; layer++) {
        const valleyZ = layer * dominantDiameter * 0.866;
        if (valleyZ + dominantDiameter > this.H) break;

        const xOffset = (layer % 2 === 1) ? dominantDiameter / 2 : 0;
        let layerX = xOffset;

        for (const cyl of group) {
          if (cyl.placed) continue;
          if (layerX + cyl.diameter > this.W) {
            layerX = xOffset; // Reset for next attempt
            continue;
          }

          const supportedZ = this.findSupportedZ(layerX, currentY, cyl, placedBoxes);
          if (supportedZ === null || supportedZ + cyl.diameter > this.H) continue;

          const pos = { x: layerX, y: currentY, z: supportedZ };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: currentY, yMax: currentY + cyl.length,
              zMin: supportedZ, zMax: supportedZ + cyl.diameter,
            });
            layerX += cyl.diameter;
          }
        }
      }

      // Also try vertical placement for any unplaced in this group
      for (const cyl of group) {
        if (cyl.placed) continue;
        if (cyl.length > this.H) continue;

        // Try vertical at various Y positions
        for (let vy = currentY; vy + cyl.diameter <= currentY + maxLength; vy += 5) {
          let found = false;
          for (let vx = 0; vx + cyl.diameter <= this.W; vx += 5) {
            const pos = { x: vx, y: vy, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
              break;
            }
          }
          if (found) break;
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

    // Try vertical for any remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      if (cyl.length > this.H) continue;
      const pos = this.findVerticalPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.diameter,
          zMin: pos.z, zMax: pos.z + cyl.length,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    console.log(`  Compact result: ${placed.length} placed, ${unplaced.length} unplaced`);
    return { placed, unplaced };
  }

  /**
   * Vertical Priority packing - prioritizes vertical placement for rolls that fit
   * This can be more efficient when rolls are short enough to stack vertically
   */
  private packVerticalPriority(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== VERTICAL PRIORITY PACKING ===`);

    // Separate cylinders that can go vertical vs those that must be horizontal
    const canBeVertical = allCylinders.filter(c => c.length <= this.H);
    const mustBeHorizontal = allCylinders.filter(c => c.length > this.H);

    console.log(`  Can be vertical: ${canBeVertical.length}, Must be horizontal: ${mustBeHorizontal.length}`);

    // Sort vertical candidates by: can stack (short length) first, then by diameter
    canBeVertical.sort((a, b) => {
      // Prefer shorter rolls that can potentially stack
      const aCanStack = a.length * 2 <= this.H;
      const bCanStack = b.length * 2 <= this.H;
      if (aCanStack !== bCanStack) return bCanStack ? 1 : -1;
      return b.diameter - a.diameter;
    });

    // Place verticals on floor first - pack by diameter groups
    const vertByDiameter = this.groupByDiameter(canBeVertical, 10);

    for (const group of vertByDiameter) {
      const d = group[0]?.diameter || 80;
      const maxPerRow = Math.floor(this.W / d);
      const maxPerCol = Math.floor(this.L / d);
      console.log(`  Vertical group D=${d}: ${group.length} cylinders, ${maxPerRow}x${maxPerCol} grid`);

      // Pack in grid pattern
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Find next grid position
        let found = false;
        for (let gy = 0; gy + cyl.diameter <= this.L && !found; gy += cyl.diameter) {
          for (let gx = 0; gx + cyl.diameter <= this.W && !found; gx += cyl.diameter) {
            const pos = { x: gx, y: gy, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }
      }
    }

    // Now place horizontals around the verticals
    mustBeHorizontal.sort((a, b) => b.length - a.length);
    for (const cyl of mustBeHorizontal) {
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

    // Stack verticals that can stack (length * 2 <= H)
    const stackable = canBeVertical.filter(c => !c.placed && c.length * 2 <= this.H);
    for (const cyl of stackable) {
      // Find a vertical cylinder to stack on
      for (const box of placedBoxes) {
        const boxW = box.xMax - box.xMin;
        const boxL = box.yMax - box.yMin;
        const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

        if (!isVertical) continue;
        if (box.zMax + cyl.length > this.H) continue;

        const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
        if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.diameter,
            zMin: pos.z, zMax: pos.z + cyl.length,
          });
          break;
        }
      }
    }

    // Place remaining unplaced verticals as horizontals
    for (const cyl of canBeVertical.filter(c => !c.placed)) {
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

    // Final exhaustive search
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
    console.log(`  Vertical priority result: ${placed.length} placed, ${unplaced.length} unplaced`);
    return { placed, unplaced };
  }

  /**
   * Pack with maximum stacking to save Y-axis space
   * Prioritizes placing multiple layers in Z before moving along Y
   */
  private packMaximizeStacking(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== MAXIMIZE STACKING PACKING ===`);

    // Group cylinders by similar diameter (within 5cm)
    const byDiameter = this.groupByDiameter(allCylinders, 5);

    // Sort groups by diameter (smallest first - they stack better)
    byDiameter.sort((a, b) => (a[0]?.diameter || 0) - (b[0]?.diameter || 0));

    // Calculate how many rows we can fit across width for each group
    for (const group of byDiameter) {
      if (group.length === 0) continue;

      const d = group[0].diameter;
      const rowsAcross = Math.floor(this.W / d);

      // Sort within group by length (longest first to maximize vertical space usage)
      group.sort((a, b) => b.length - a.length);

      console.log(`  Group D=${d}: ${group.length} cylinders, ${rowsAcross} rows across`);

      // Place cylinders in columns, stacking vertically
      for (const cyl of group) {
        if (cyl.placed) continue;

        let found = false;

        // Try to stack on existing placement first
        if (cyl.length <= this.H) {
          for (const box of placedBoxes) {
            const boxW = box.xMax - box.xMin;
            const boxL = box.yMax - box.yMin;
            const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

            if (!isVertical) continue;
            if (Math.abs(boxW - cyl.diameter) > 5) continue; // Similar diameter
            if (box.zMax + cyl.length > this.H) continue;

            const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: pos.z, zMax: pos.z + cyl.length,
              });
              found = true;
              break;
            }
          }
        }

        if (found) continue;

        // Try new floor position
        for (let y = 0; y + cyl.diameter <= this.L && !found; y += cyl.diameter) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += cyl.diameter) {
            // Try vertical first if possible
            if (cyl.length <= this.H) {
              const vPos = { x, y, z: 0 };
              if (this.canPlaceVertical(vPos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, vPos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }

            // Try horizontal if vertical didn't work
            if (!found) {
              const hPos = { x, y, z: 0 };
              if (this.canPlace(hPos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, hPos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.length,
                  zMin: 0, zMax: cyl.diameter,
                });
                found = true;
              }
            }
          }
        }
      }
    }

    // Place remaining cylinders using exhaustive search
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      // Try stacking first
      let found = false;

      if (cyl.length <= this.H) {
        for (const box of placedBoxes) {
          const boxW = box.xMax - box.xMin;
          const boxL = box.yMax - box.yMin;
          const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

          if (!isVertical) continue;
          if (box.zMax + cyl.length > this.H) continue;

          const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
          if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.diameter,
              zMin: pos.z, zMax: pos.z + cyl.length,
            });
            found = true;
            break;
          }
        }
      }

      if (!found) {
        // Try horizontal on top of verticals
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

    // Final exhaustive search
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
    console.log(`  Maximize stacking result: ${placed.length} placed, ${unplaced.length} unplaced`);
    return { placed, unplaced };
  }

  /**
   * Pack with tight horizontal layering - fills each Y slice completely before moving
   * This approach maximizes horizontal layers to use container length efficiently
   */
  private packTightLayers(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== TIGHT LAYERS PACKING ===`);

    // Sort by length first (longest first), then diameter
    const sorted = [...allCylinders].sort((a, b) => {
      if (Math.abs(b.length - a.length) > 5) return b.length - a.length;
      return b.diameter - a.diameter;
    });

    // Place in layers - fill width first, then stack in height, then advance in length
    let currentY = 0;
    let layerMaxLen = 0;

    while (sorted.some(c => !c.placed) && currentY < this.L) {
      // Find unplaced cylinders that can fit at currentY
      const toPlace = sorted.filter(c => !c.placed);
      if (toPlace.length === 0) break;

      // Sort by what fits best at this Y position
      toPlace.sort((a, b) => b.diameter - a.diameter);

      layerMaxLen = 0;

      for (const cyl of toPlace) {
        if (cyl.placed) continue;

        // Check if this cylinder can fit at this Y level
        if (currentY + cyl.length > this.L && currentY + cyl.diameter > this.L) continue;

        // Try to place: first horizontal-Y, then horizontal-X, then vertical
        let found = false;

        // Try horizontal-Y (length along Y)
        if (currentY + cyl.length <= this.L) {
          for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y: currentY, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: currentY, yMax: currentY + cyl.length,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  layerMaxLen = Math.max(layerMaxLen, cyl.length);
                  found = true;
                }
              }
            }
          }
        }

        // Try horizontal-X (length along X) if it fits
        if (!found && cyl.length <= this.W && currentY + cyl.diameter <= this.L) {
          for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
              const pos = { x, y: currentY, z };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.length,
                    yMin: currentY, yMax: currentY + cyl.diameter,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  layerMaxLen = Math.max(layerMaxLen, cyl.diameter);
                  found = true;
                }
              }
            }
          }
        }

        // Try vertical
        if (!found && cyl.length <= this.H && currentY + cyl.diameter <= this.L) {
          for (let z = 0; z + cyl.length <= this.H && !found; z += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y: currentY, z };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                  const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: currentY, yMax: currentY + cyl.diameter,
                    zMin: z, zMax: z + cyl.length,
                  });
                  layerMaxLen = Math.max(layerMaxLen, cyl.diameter);
                  found = true;
                }
              }
            }
          }
        }
      }

      // Move to next Y position
      if (layerMaxLen > 0) {
        currentY += layerMaxLen;
      } else {
        currentY += 10; // Move forward if nothing placed
      }
    }

    // Final exhaustive search
    for (const cyl of sorted.filter(c => !c.placed)) {
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
    console.log(`  Tight layers result: ${placed.length} placed, ${unplaced.length} unplaced`);
    return { placed, unplaced };
  }

  /**
   * Aggressive placement - tries ALL positions at step=1 for a single cylinder
   * Used as final fallback when main strategies leave 1-2 unplaced
   */
  private tryAggressivePlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
    const { diameter, length } = cyl;

    console.log(`    Aggressive search for D${diameter} L${length}...`);

    // Collect ALL Z levels
    const zLevels: number[] = [0];
    for (const box of placedBoxes) {
      if (!zLevels.includes(box.zMax)) {
        zLevels.push(box.zMax);
      }
    }
    zLevels.sort((a, b) => a - b);
    console.log(`    Z levels: ${zLevels.slice(0, 10).join(', ')}${zLevels.length > 10 ? '...' : ''}`);

    // 1. Try horizontal-Y at EVERY Z level with step=1
    for (const z of zLevels) {
      if (z + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (z === 0 || this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
              console.log(`    Found horizontal-Y at z=${z}`);
              return { pos, orientation: 'horizontal-y' };
            }
          }
        }
      }
    }

    // 2. Try horizontal-X at EVERY Z level
    if (length <= this.W) {
      for (const z of zLevels) {
        if (z + diameter > this.H) continue;

        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + length <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasRotatedSupportRelaxed(pos, diameter, length, placedBoxes)) {
                console.log(`    Found horizontal-X at z=${z}`);
                return { pos, orientation: 'horizontal-x' };
              }
            }
          }
        }
      }
    }

    // 3. Try vertical at EVERY Z level
    if (length <= this.H) {
      for (const z of zLevels) {
        if (z + length > this.H) continue;

        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + diameter <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasVerticalSupportRelaxed(pos, diameter, placedBoxes)) {
                console.log(`    Found vertical at z=${z}`);
                return { pos, orientation: 'vertical' };
              }
            }
          }
        }
      }
    }

    // 4. Try ANY Z position (not just tops of boxes) with floor support
    console.log(`    Trying arbitrary Z positions...`);
    for (let z = 1; z + diameter <= this.H; z += 1) {
      for (let y = 0; y + length <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
              console.log(`    Found horizontal-Y at arbitrary z=${z}`);
              return { pos, orientation: 'horizontal-y' };
            }
          }
        }
      }
    }

    console.log(`    No position found for D${diameter} L${length}`);
    return null;
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
   * Find ANY valid position for a cylinder using step=1 precision search
   * Tries all three orientations and relaxed support requirements
   */
  private findAnyValidPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[],
    zLevels: number[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
    const { diameter, length } = cyl;

    // Try ALL orientations at floor level first with step=1
    // 1. Horizontal-Y at floor
    for (let y = 0; y + length <= this.L; y += 1) {
      for (let x = 0; x + diameter <= this.W; x += 1) {
        const pos = { x, y, z: 0 };
        if (this.canPlace(pos, diameter, length, placedBoxes)) {
          return { pos, orientation: 'horizontal-y' };
        }
      }
    }

    // 2. Vertical at floor (if fits in height)
    if (length <= this.H) {
      for (let y = 0; y + diameter <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
            return { pos, orientation: 'vertical' };
          }
        }
      }
    }

    // 3. Horizontal-X at floor (if fits in width)
    if (length <= this.W) {
      for (let y = 0; y + diameter <= this.L; y += 1) {
        for (let x = 0; x + length <= this.W; x += 1) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
            return { pos, orientation: 'horizontal-x' };
          }
        }
      }
    }

    // Try stacking positions at Z levels
    for (const z of zLevels) {
      if (z === 0) continue;

      // Horizontal-Y stacking
      if (z + diameter <= this.H) {
        for (let y = 0; y + length <= this.L; y += 1) {
          for (let x = 0; x + diameter <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlace(pos, diameter, length, placedBoxes)) {
              if (this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
                return { pos, orientation: 'horizontal-y' };
              }
            }
          }
        }
      }

      // Vertical stacking
      if (length <= this.H && z + length <= this.H) {
        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + diameter <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
              if (this.hasVerticalSupportRelaxed(pos, diameter, placedBoxes)) {
                return { pos, orientation: 'vertical' };
              }
            }
          }
        }
      }

      // Horizontal-X stacking
      if (length <= this.W && z + diameter <= this.H) {
        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + length <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
              if (this.hasRotatedSupportRelaxed(pos, diameter, length, placedBoxes)) {
                return { pos, orientation: 'horizontal-x' };
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Relaxed support check - allows more flexible stacking
   */
  private hasSupportRelaxed(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      // Check if this box could provide support (their top is near our bottom)
      if (Math.abs(box.zMax - z) > 10) continue;
      if (box.zMax > z + 5) continue;

      // Check Y overlap
      const yOverlap = Math.min(y + length, box.yMax) - Math.max(y, box.yMin);
      if (yOverlap <= 0) continue;

      // Check X overlap
      const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
      if (xOverlap > 0) {
        // Relaxed: just need SOME overlap
        return true;
      }
    }

    return false;
  }

  /**
   * Relaxed vertical support check
   */
  private hasVerticalSupportRelaxed(
    pos: { x: number; y: number; z: number },
    diameter: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      if (Math.abs(box.zMax - z) > 10) continue;
      if (box.zMax > z + 5) continue;

      // Check overlap in both X and Y
      const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
      const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

      if (xOverlap > 0 && yOverlap > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Relaxed support check for rotated horizontal
   */
  private hasRotatedSupportRelaxed(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      if (Math.abs(box.zMax - z) > 10) continue;
      if (box.zMax > z + 5) continue;

      // Check overlap (rotated: length along X, diameter along Y)
      const xOverlap = Math.min(x + length, box.xMax) - Math.max(x, box.xMin);
      const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

      if (xOverlap > 0 && yOverlap > 0) {
        return true;
      }
    }

    return false;
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

    // Center of new HORIZONTAL cylinder in XZ plane
    const cx = x + radius;
    const cz = z + radius;

    // Check collision with each placed item
    for (const box of placed) {
      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;

      // Detect if this box is a VERTICAL cylinder (height > width significantly)
      const isVerticalBox = boxH > boxW * 1.5;

      if (isVerticalBox) {
        // Collision: new HORIZONTAL vs existing VERTICAL
        // First check if bounding boxes overlap at all
        if (x >= box.xMax || x + diameter <= box.xMin) continue;
        if (y >= box.yMax || y + length <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;

        // Bounding boxes overlap - but horizontal may be resting ON TOP of vertical
        // hasSupport allows 5cm tolerance for horizontal-on-vertical stacking
        // If bottom of horizontal (z) is at or near top of vertical (box.zMax), allow it
        if (z >= box.zMax - 5) {
          continue; // Horizontal resting on top of vertical - not a collision
        }

        // Horizontal cylinder passing through vertical - actual collision
        return false;
      } else {
        // Collision: new HORIZONTAL vs existing HORIZONTAL
        // Both are circular in XZ plane, extended in Y

        // First check Y overlap
        if (y >= box.yMax || y + length <= box.yMin) {
          continue; // No Y overlap, no collision possible
        }

        // Y overlaps, now check XZ circular collision
        const otherRadius = boxW / 2;
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
    }

    return true;
  }

  /**
   * Find the exact Z position where a cylinder would rest based on supports
   * Returns the Z coordinate (bottom of cylinder) or null if no support found
   */
  private findSupportedZ(
    x: number, y: number,
    cyl: Cylinder,
    placed: PlacedBox[]
  ): number | null {
    const { diameter, length } = cyl;
    const radius = diameter / 2;
    const cx = x + radius;

    // If at floor level, return 0
    if (placed.length === 0) return 0;

    // Find all potential supports (cylinders that overlap in Y and could support this position)
    const supports: { box: PlacedBox; cx: number; cz: number; r: number }[] = [];

    for (const box of placed) {
      // Check Y overlap
      if (y >= box.yMax || y + length <= box.yMin) continue;

      const boxR = (box.xMax - box.xMin) / 2;
      const boxCx = box.xMin + boxR;
      const boxCz = box.zMin + boxR;

      // Check if horizontally close enough to potentially support
      const dx = Math.abs(cx - boxCx);
      if (dx <= radius + boxR + 5) {
        supports.push({ box, cx: boxCx, cz: boxCz, r: boxR });
      }
    }

    if (supports.length === 0) {
      // No supports nearby - can only place on floor
      return 0;
    }

    // Sort supports by Z (top of cylinder) descending to find highest position
    supports.sort((a, b) => b.box.zMax - a.box.zMax);

    // Check for direct stacking on a single cylinder
    for (const support of supports) {
      const dx = Math.abs(cx - support.cx);
      // Direct stacking: centers are aligned enough
      if (dx <= Math.max(radius, support.r) * 0.5) {
        // Rest directly on top
        return support.box.zMax;
      }
    }

    // Check for valley support between two cylinders
    for (let i = 0; i < supports.length; i++) {
      for (let j = i + 1; j < supports.length; j++) {
        const s1 = supports[i];
        const s2 = supports[j];

        // Check if both supports are at similar height
        if (Math.abs(s1.cz - s2.cz) > 10) continue;

        const cx1 = s1.cx;
        const cx2 = s2.cx;
        const r1 = s1.r;
        const r2 = s2.r;
        const avgR = (r1 + r2) / 2;

        // Distance between support centers
        const dxSupport = Math.abs(cx2 - cx1);

        // Check if new cylinder center is between supports
        const minCx = Math.min(cx1, cx2);
        const maxCx = Math.max(cx1, cx2);

        if (cx >= minCx - 5 && cx <= maxCx + 5) {
          // Calculate expected Z for valley nesting
          // Center-to-center distance in X from new cylinder to each support
          const halfGap = dxSupport / 2;
          const sumRadii = radius + avgR;

          if (sumRadii > halfGap) {
            // Calculate Z where cylinder rests in valley
            const avgSupportCz = (s1.cz + s2.cz) / 2;
            const rise = Math.sqrt(sumRadii * sumRadii - halfGap * halfGap);
            const expectedCz = avgSupportCz + rise;
            const expectedZ = expectedCz - radius;

            if (expectedZ > 0 && expectedZ + diameter <= this.H) {
              return expectedZ;
            }
          }
        }
      }
    }

    // Check for wall + single cylinder support
    if (x <= 5 || x + diameter >= this.W - 5) {
      const wallCx = x <= 5 ? 0 : this.W;
      const dxToWall = Math.abs(cx - wallCx);

      for (const support of supports) {
        const dx = Math.abs(cx - support.cx);
        const sumRadii = radius + support.r;

        // Calculate valley-like Z with wall as one support
        if (dxToWall < radius && dx < sumRadii) {
          // Wall provides one side of support
          const halfGap = dx / 2;
          if (sumRadii > halfGap) {
            const rise = Math.sqrt(sumRadii * sumRadii - halfGap * halfGap);
            const expectedCz = support.cz + rise;
            const expectedZ = expectedCz - radius;

            if (expectedZ > 0 && expectedZ + diameter <= this.H) {
              return expectedZ;
            }
          }
        }
      }
    }

    // If no proper support found, try direct stacking with more tolerance
    for (const support of supports) {
      const xOverlap = Math.min(x + diameter, support.box.xMax) - Math.max(x, support.box.xMin);
      if (xOverlap >= diameter * 0.3) {
        return support.box.zMax;
      }
    }

    return null;
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
    // 1. Single cylinder directly below (stacking on top) - horizontal or vertical
    // 2. Two cylinders forming a valley (cylinder rests in the gap)

    // FIRST: Check for support from VERTICAL cylinders (horizontal on vertical stacking)
    for (const box of placed) {
      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;
      const isVerticalBox = boxH > boxW * 1.5;

      if (isVerticalBox) {
        // Check if this vertical can support us
        // Our bottom (z) should be at or near vertical's top (zMax)
        if (Math.abs(box.zMax - z) <= 5) {
          // Check X overlap
          const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
          // Check Y overlap (vertical has small Y extent = diameter)
          const yOverlap = Math.min(y + length, box.yMax) - Math.max(y, box.yMin);

          // Need some overlap in both X and Y
          if (xOverlap > 0 && yOverlap > 0) {
            console.log(`  Support found: horizontal on vertical at z=${z}, box.zMax=${box.zMax}`);
            return true;
          }
        }
      }
    }

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
   * AGGRESSIVE: tries floor, stacking on horizontals, any available space
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

    console.log(`    Searching vertical position for D${diameter} L${length}...`);

    // Strategy 1: Find Y gaps where no horizontal cylinders exist
    // Collect all Y ranges used by placed items
    const yRanges: { start: number; end: number }[] = [];
    for (const box of placed) {
      yRanges.push({ start: box.yMin, end: box.yMax });
    }
    yRanges.sort((a, b) => a.start - b.start);

    // Find Y gaps
    const yGaps: { start: number; end: number }[] = [];
    let lastEnd = 0;
    for (const range of yRanges) {
      if (range.start > lastEnd) {
        yGaps.push({ start: lastEnd, end: range.start });
      }
      lastEnd = Math.max(lastEnd, range.end);
    }
    // Add final gap at end of container
    if (lastEnd < this.L) {
      yGaps.push({ start: lastEnd, end: this.L });
    }

    console.log(`      Y gaps found: ${yGaps.map(g => `[${g.start}-${g.end}]`).join(', ')}`);

    // Try floor positions in Y gaps first
    for (const gap of yGaps) {
      if (gap.end - gap.start < diameter) continue;

      for (let y = gap.start; y + diameter <= gap.end; y += 5) {
        for (let x = 0; x + diameter <= this.W; x += 5) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            console.log(`      Found floor position in Y gap at (${x}, ${y}, 0)`);
            return pos;
          }
        }
      }
    }

    // Strategy 2: Stack on top of horizontal cylinders
    // For each placed box, try placing vertical cylinder on top
    const zLevelsWithBoxes = new Map<number, PlacedBox[]>();
    for (const box of placed) {
      const z = box.zMax;
      if (!zLevelsWithBoxes.has(z)) zLevelsWithBoxes.set(z, []);
      zLevelsWithBoxes.get(z)!.push(box);
    }

    // Sort Z levels ascending (try lower positions first)
    const sortedZLevels = Array.from(zLevelsWithBoxes.keys()).sort((a, b) => a - b);

    for (const z of sortedZLevels) {
      if (z + length > this.H) continue;

      const boxesAtLevel = zLevelsWithBoxes.get(z)!;
      console.log(`      Trying z=${z} (${boxesAtLevel.length} boxes at this level)`);

      for (const box of boxesAtLevel) {
        // Try placing centered on this box
        const boxCenterX = (box.xMin + box.xMax) / 2;
        const boxCenterY = (box.yMin + box.yMax) / 2;

        // Try various positions on top of this box
        const tryPositions = [
          { x: boxCenterX - diameter / 2, y: boxCenterY - diameter / 2 },
          { x: box.xMin, y: box.yMin },
          { x: box.xMin, y: boxCenterY - diameter / 2 },
          { x: boxCenterX - diameter / 2, y: box.yMin },
        ];

        for (const tryPos of tryPositions) {
          // Clamp to container bounds
          const x = Math.max(0, Math.min(tryPos.x, this.W - diameter));
          const y = Math.max(0, Math.min(tryPos.y, this.L - diameter));

          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (this.hasVerticalSupport(pos, diameter, placed)) {
              console.log(`      Found stacked position at (${x}, ${y}, ${z})`);
              return pos;
            }
          }
        }
      }
    }

    // Strategy 3: Exhaustive grid search at all Z levels
    console.log(`      Trying exhaustive search...`);
    for (const z of [0, ...sortedZLevels]) {
      if (z + length > this.H) continue;

      for (let y = 0; y + diameter <= this.L; y += 10) {
        for (let x = 0; x + diameter <= this.W; x += 10) {
          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (z === 0 || this.hasVerticalSupport(pos, diameter, placed)) {
              console.log(`      Found position at (${x}, ${y}, ${z})`);
              return pos;
            }
          }
        }
      }
    }

    // Strategy 4: Fine grid search
    console.log(`      Trying fine grid search...`);
    for (const z of [0, ...sortedZLevels]) {
      if (z + length > this.H) continue;

      for (let y = 0; y + diameter <= this.L; y += 2) {
        for (let x = 0; x + diameter <= this.W; x += 2) {
          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (z === 0 || this.hasVerticalSupport(pos, diameter, placed)) {
              console.log(`      Found position at (${x}, ${y}, ${z})`);
              return pos;
            }
          }
        }
      }
    }

    console.log(`      No vertical position found`);
    return null;
  }

  /**
   * Check if vertical cylinder can be placed (no collision)
   * Handles both vertical-vs-vertical and vertical-vs-horizontal collisions
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
        continue; // No Z overlap, no collision
      }

      // Z overlaps - check XY collision
      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;

      // Determine if box is a horizontal cylinder (long in Y) or vertical (square-ish)
      if (Math.abs(boxW - boxL) < 10) {
        // Square-ish box - another vertical cylinder, use circular collision
        const otherR = boxW / 2;
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
        // Horizontal cylinder (long in Y direction)
        // The horizontal cylinder is circular in XZ plane, rectangular in XY projection
        // For simplicity, check if vertical cylinder circle overlaps with box rectangle

        // Circle-rectangle collision: find closest point on rectangle to circle center
        const closestX = Math.max(box.xMin, Math.min(cx, box.xMax));
        const closestY = Math.max(box.yMin, Math.min(cy, box.yMax));

        const dx = cx - closestX;
        const dy = cy - closestY;
        const distSq = dx * dx + dy * dy;

        // Tolerance for touching
        const minDist = radius - 1;

        if (distSq < minDist * minDist) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if vertical cylinder has support below
   * Supports resting on horizontal cylinders, vertical cylinders, or multiple items
   */
  private hasVerticalSupport(
    pos: { x: number; y: number; z: number },
    diameter: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cx = x + radius;
    const cy = y + radius;

    // Find all boxes that could provide support (their top is at or near our bottom)
    const supportCandidates: PlacedBox[] = [];
    for (const box of placed) {
      // Support must be below us (their zMax near our z)
      if (box.zMax <= z + 5 && box.zMax >= z - 5) {
        supportCandidates.push(box);
      }
    }

    // Check for any overlapping support
    for (const box of supportCandidates) {
      const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
      const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

      // Need at least 30% overlap in both directions for stability
      if (xOverlap > diameter * 0.3 && yOverlap > diameter * 0.3) {
        return true;
      }
    }

    // Also check for multi-point support (resting on multiple items)
    // Calculate total support area from all candidates
    let totalSupportArea = 0;
    const requiredArea = diameter * diameter * 0.25; // Need 25% coverage

    for (const box of supportCandidates) {
      const xOverlap = Math.max(0, Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin));
      const yOverlap = Math.max(0, Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin));
      totalSupportArea += xOverlap * yOverlap;
    }

    if (totalSupportArea >= requiredArea) {
      return true;
    }

    // Special case: resting on top of a horizontal cylinder
    // The vertical cylinder can rest on the curved top of a horizontal cylinder
    for (const box of supportCandidates) {
      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;

      // Is this a horizontal cylinder? (long in Y)
      if (boxL > boxW * 2) {
        // Check if vertical cylinder center is within the horizontal cylinder's X range
        if (cx >= box.xMin && cx <= box.xMax) {
          // Check if within Y range
          if (cy >= box.yMin && cy <= box.yMax) {
            return true;
          }
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

  /**
   * Create a rotated horizontal cylinder (length along X instead of Y)
   */
  private createRotatedPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + cyl.length / 2,
        y: pos.y + radius,
        z: pos.z + radius,
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-x',
      rotation: ORIENTATION_ROTATIONS['horizontal-x'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  /**
   * Check if a rotated horizontal cylinder (length along X) can be placed
   */
  private canPlaceRotated(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;

    // Check container bounds (rotated: length along X, diameter along Y and Z)
    if (x < 0 || x + length > this.W) return false;
    if (y < 0 || y + diameter > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    // Center of rotated cylinder in YZ plane
    const cy = y + radius;
    const cz = z + radius;

    // Check collision with each placed item
    for (const box of placed) {
      // Check X overlap first (our length is along X)
      if (x >= box.xMax || x + length <= box.xMin) continue;

      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;
      const boxH = box.zMax - box.zMin;

      // Detect box type
      const isVerticalBox = boxH > boxW * 1.5 && boxH > boxL * 1.5;
      const isRotatedHorizontal = boxW > boxL * 1.5; // Length along X

      if (isVerticalBox) {
        // Vertical cylinder collision
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;
        // Allow resting on top
        if (z >= box.zMax - 5) continue;
        return false;
      } else if (isRotatedHorizontal) {
        // Another rotated horizontal - both circular in YZ
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;

        const otherR = boxL / 2;
        const otherCy = box.yMin + otherR;
        const otherCz = box.zMin + otherR;

        const dy = cy - otherCy;
        const dz = cz - otherCz;
        const distSq = dy * dy + dz * dz;
        const minDist = radius + otherR - 1;

        if (distSq < minDist * minDist) return false;
      } else {
        // Normal horizontal (length along Y) - circular in XZ
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;
        // Conservative bounding box for cross-orientation
        return false;
      }
    }

    return true;
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
