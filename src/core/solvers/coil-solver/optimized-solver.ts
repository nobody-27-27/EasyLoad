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
  orientation: 'vertical' | 'horizontal-x' | 'horizontal-y';
}

/**
 * Cross-section packing solver
 *
 * Strategy: Multi-strategy approach to find the best fit.
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

    console.log(`=== CYLINDER PACKING (AI Multi-Strategy) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    // --- STRATEGY DEFINITIONS ---
    const strategies = [
      {
        name: 'HumanLogic_HeightFirst',
        fn: () => this.packHumanLogic(all, 'height-desc')
      },
      {
        name: 'HumanLogic_DiameterFirst',
        fn: () => this.packHumanLogic(all, 'diameter-desc')
      },
      {
        name: 'VerticalPriority',
        fn: () => this.packVerticalPriority(all)
      },
      {
        name: 'MixedOrientations_Volume',
        fn: () => this.packMixedOrientations(all)
      },
      {
        name: 'LargestFirst',
        fn: () => this.packLargestFirst(all)
      },
      // Random Search - The AI fallback
      {
        name: 'PerfectColumns',
        fn: () => this.packByPerfectColumns(all)
      },
      {
        name: 'RandomizedSearch',
        fn: () => this.packRandomized(all)
      }
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; score: number; name: string; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      console.log(`\n--- Running Strategy: ${strategy.name} ---`);

      // Reset placed status for clean run
      all.forEach(c => c.placed = false);

      // Run Strategy
      const result = strategy.fn();

      // Convert result to PlacedBox[] for the aggressive pass
      const placedBoxes: PlacedBox[] = result.placed.map(p => this.createBoxFromPlaced(p));

      // Run Aggressive Pass (Fill Gaps)
      const aggressiveAdded = this.runAggressivePass(all, placedBoxes, result.placed);

      // Recalculate true placed count
      const currentPlacedCount = all.filter(c => c.placed).length;

      const score = currentPlacedCount * 1000;

      console.log(`  > Result: ${currentPlacedCount}/${all.length} placed.`);

      if (!bestResult || score > bestResult.score) {
        bestResult = {
          placed: [...result.placed], // Clone
          unplaced: all.filter(c => !c.placed).map(c => c.item),
          score,
          name: strategy.name,
          placedBoxes
        };
      }

      // Early exit if perfect
      if (currentPlacedCount === all.length) {
        console.log(`  > Perfect match found!`);
        break;
      }
    }

    if (!bestResult) return this.emptyResult();

    console.log(`\n=== BEST STRATEGY: ${bestResult.name} (${bestResult.placed.length}/${all.length}) ===`);

    // Deduplicate placed items just in case
    const uniquePlaced: PlacedCylinder[] = [];
    const seenIds = new Set<string>();

    for(const p of bestResult.placed) {
        const key = `${p.item.name}_${p.position.x}_${p.position.y}_${p.position.z}`;
        if(!seenIds.has(key)) {
            seenIds.add(key);
            uniquePlaced.push(p);
        }
    }

    return {
      placedCylinders: uniquePlaced,
      unplacedItems: bestResult.unplaced,
      statistics: this.calcStats(uniquePlaced, bestResult.unplaced.length),
    };
  }

  // --- RANDOMIZED STRATEGY ---
  private packRandomized(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      console.log("  Running Randomized Search (50 iterations)...");
      let bestLocalResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } = { placed: [], unplaced: [] };
      let bestCount = -1;

      // Create a working copy
      const workingSet = [...allCylinders];

      const startTime = Date.now();
      const TIME_LIMIT_MS = 15000; // 15 seconds max

      // Phase 1: Pure Random (Explore diverse solutions)
      // Phase 2: Smart Shuffle (Keep big items first, shuffle small ones)

      for(let i=0; i<100; i++) {
          if (Date.now() - startTime > TIME_LIMIT_MS) break;

          // Strategy Switch: First 30% iters are pure random, then Smart Shuffle
          if (i < 30) {
             this.shuffle(workingSet);
          } else {
             // Smart Shuffle: Sort by Volume Desc, keep top 30% fixed, shuffle rest
             // This ensures big items are placed first (foundation), small items fill gaps
             workingSet.sort((a,b) => (b.diameter**2 * b.length) - (a.diameter**2 * a.length));

             const keepCount = Math.floor(workingSet.length * 0.3);
             const fixedPart = workingSet.slice(0, keepCount);
             const shufflePart = workingSet.slice(keepCount);
             this.shuffle(shufflePart);

             // Reconstruct working set (must modify array in place or copy back)
             // splice to replace content
             workingSet.length = 0;
             workingSet.push(...fixedPart, ...shufflePart);
          }

          // Reset flags
          workingSet.forEach(c => c.placed = false);

          // Run Greedy Strict Order (respects shuffle)
          const currentResult = this.packGreedyStrictOrder(workingSet);

          // Aggressive pass locally to see true potential
           const pBoxes = currentResult.placed.map(p => this.createBoxFromPlaced(p));
           this.runAggressivePass(workingSet, pBoxes, currentResult.placed);
           const totalPlaced = currentResult.placed.length;

           if (totalPlaced > bestCount) {
               bestCount = totalPlaced;
               bestLocalResult = {
                   placed: [...currentResult.placed], // Clone the placed array
                   unplaced: workingSet.filter(c => !c.placed).map(c => c.item)
               };
               console.log(`    Iter ${i}: Found new best: ${totalPlaced}`);

               // Save the cylinder IDs that were placed in this best run
               // We need this to restore the state later

               if (totalPlaced === allCylinders.length) break;
           }
      }

      // Restore the 'placed' flags on the original cylinder objects to match the best result
      allCylinders.forEach(c => c.placed = false);
      const placedIds = new Set(bestLocalResult.placed.map(p => p.uniqueId));
      // Note: uniqueId in placed cylinder was generated from cylinder index usually?
      // Actually my createPlacedCylinder uses: uniqueId: `cyl_${cyl.index}_...`

      // We need to map back to the cylinder objects.
      // The bestLocalResult.placed contains PlacedCylinder objects.
      // We can iterate them and find the corresponding cylinder in allCylinders by checking some ID or index.
      // My PlacedCylinder doesn't strictly store the original cylinder index in a clean property,
      // but it does store the `item`.

      // Better way: Re-run the placement for the best permutation? No, that's non-deterministic if I use random ID.
      // I need to mark the cylinders as placed.

      // The `allCylinders` are the SAME objects as in `workingSet`.
      // `bestLocalResult.placed` refers to these items.

      // Let's use the `index` property I added to the Cylinder interface!
      const placedIndices = new Set<number>();
      for (const p of bestLocalResult.placed) {
          // Extract index from uniqueId "cyl_INDEX_..."
          const parts = p.uniqueId.split('_');
          if (parts.length >= 2) {
              const idx = parseInt(parts[1], 10);
              if (!isNaN(idx)) placedIndices.add(idx);
          }
      }

      allCylinders.forEach(c => {
          if (placedIndices.has(c.index)) c.placed = true;
      });

      return bestLocalResult;
  }

  private packGreedyStrictOrder(cylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      const placed: PlacedCylinder[] = [];
      const placedBoxes: PlacedBox[] = [];

      for(const cyl of cylinders) {
          if (cyl.placed) continue;

          // Try Vertical
          if (cyl.length <= this.H) {
               // Simple grid search
               let found = false;
               for (let y = 0; y + cyl.diameter <= this.L; y += 1) {
                   for(let x=0; x+cyl.diameter <= this.W; x += 1) {
                       const pos = {x,y,z:0};
                       if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                            const p = this.createVerticalPlacedCylinder(cyl, pos);
                            placed.push(p);
                            placedBoxes.push(this.createBoxFromPlaced(p));
                            cyl.placed = true;
                            found = true;
                            y=this.L; x=this.W;
                       }
                   }
               }
               if (found) continue;
          }

          // Try Horizontal
          const res = this.tryAggressivePlacement(cyl, placedBoxes);
          if (res) {
             if (res.orientation === 'vertical') {
                const p = this.createVerticalPlacedCylinder(cyl, res.pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;
             } else if (res.orientation === 'horizontal-y') {
                const p = this.createPlacedCylinder(cyl, res.pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;
             } else {
                const p = this.createRotatedPlacedCylinder(cyl, res.pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;
             }
          }
      }

      return { placed, unplaced: cylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private shuffle(array: any[]) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
  }


  // --- HELPERS ---

  private createBoxFromPlaced(p: PlacedCylinder): PlacedBox {
      const isVertical = p.orientation === 'vertical';
      const isRotated = p.orientation === 'horizontal-x';

      if (isVertical) {
        return {
          xMin: p.position.x, xMax: p.position.x + p.radius * 2,
          yMin: p.position.y, yMax: p.position.y + p.radius * 2,
          zMin: p.position.z, zMax: p.position.z + p.length,
          orientation: 'vertical',
        };
      } else if (isRotated) {
        return {
          xMin: p.position.x, xMax: p.position.x + p.length,
          yMin: p.position.y, yMax: p.position.y + p.radius * 2,
          zMin: p.position.z, zMax: p.position.z + p.radius * 2,
          orientation: 'horizontal-x',
        };
      } else {
        return {
          xMin: p.position.x, xMax: p.position.x + p.radius * 2,
          yMin: p.position.y, yMax: p.position.y + p.length,
          zMin: p.position.z, zMax: p.position.z + p.radius * 2,
          orientation: 'horizontal-y',
        };
      }
  }

  private runAggressivePass(all: Cylinder[], placedBoxes: PlacedBox[], placedArray: PlacedCylinder[]): number {
      const unplaced = all.filter(c => !c.placed);
      if (unplaced.length === 0) return 0;

      let added = 0;
      // console.log(`  Aggressive Pass: Trying to fit ${unplaced.length} remaining items...`);

      // Sort small to large to fit gaps
      unplaced.sort((a,b) => a.diameter - b.diameter);

      for (const cyl of unplaced) {
        const result = this.tryAggressivePlacement(cyl, placedBoxes);
        if (result) {
             // Strict check bounds
             const EPS = 0.1;
             let fits = true;

             if (result.orientation === 'horizontal-x') {
                 if (result.pos.x < -EPS || result.pos.x + cyl.length > this.W + EPS) fits = false;
                 if (result.pos.y < -EPS || result.pos.y + cyl.diameter > this.L + EPS) fits = false;
                 if (result.pos.z < -EPS || result.pos.z + cyl.diameter > this.H + EPS) fits = false;
             } else if (result.orientation === 'vertical') {
                 if (result.pos.x < -EPS || result.pos.x + cyl.diameter > this.W + EPS) fits = false;
                 if (result.pos.y < -EPS || result.pos.y + cyl.diameter > this.L + EPS) fits = false;
                 if (result.pos.z < -EPS || result.pos.z + cyl.length > this.H + EPS) fits = false;
             } else {
                 if (result.pos.x < -EPS || result.pos.x + cyl.diameter > this.W + EPS) fits = false;
                 if (result.pos.y < -EPS || result.pos.y + cyl.length > this.L + EPS) fits = false;
                 if (result.pos.z < -EPS || result.pos.z + cyl.diameter > this.H + EPS) fits = false;
             }

             if (!fits) continue;

             // Add
             let placedCyl: PlacedCylinder;
             let newBox: PlacedBox;

             if (result.orientation === 'horizontal-y') {
                placedCyl = this.createPlacedCylinder(cyl, result.pos);
                newBox = {
                    orientation: 'horizontal-y',
                    xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
                    yMin: result.pos.y, yMax: result.pos.y + cyl.length,
                    zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
                };
             } else if (result.orientation === 'vertical') {
                placedCyl = this.createVerticalPlacedCylinder(cyl, result.pos);
                newBox = {
                    orientation: 'vertical',
                    xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
                    yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
                    zMin: result.pos.z, zMax: result.pos.z + cyl.length,
                };
             } else {
                placedCyl = this.createRotatedPlacedCylinder(cyl, result.pos);
                newBox = {
                    orientation: 'horizontal-x',
                    xMin: result.pos.x, xMax: result.pos.x + cyl.length,
                    yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
                    zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
                };
             }

             placedArray.push(placedCyl);
             placedBoxes.push(newBox);
             cyl.placed = true;
             added++;
             // console.log(`    Aggressive Saved: ${cyl.item.name}`);
        }
      }
      return added;
  }

  /**
   * Human Logic Packing:
   * 1. Fill floor with Verticals.
   * 2. Place Horizontals on top (Attic).
   */
  private packHumanLogic(allCylinders: Cylinder[], sortMode: 'height-desc' | 'diameter-desc'): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);
    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // --- PHASE 1: VERTICALS ---
    // Sort
    const verticalCandidates = [...allCylinders].sort((a, b) => {
        if (sortMode === 'height-desc') {
             if (Math.abs(b.length - a.length) > 1) return b.length - a.length;
             return b.diameter - a.diameter;
        } else {
             // Diameter desc
             if (Math.abs(b.diameter - a.diameter) > 1) return b.diameter - a.diameter;
             return b.length - a.length;
        }
    });

    for (const cyl of verticalCandidates) {
      if (cyl.placed) continue;

      // Only try Vertical if it fits in Height
      if (cyl.length > this.H) continue;

      // 1. Try to Stack on existing Vertical
      let stacked = false;
        for (const box of placedBoxes) {
          if (box.orientation !== 'vertical') continue;

          const boxW = box.xMax - box.xMin;
          if (Math.abs(boxW - cyl.diameter) > 5) continue; // Must be similar diameter

          if (box.zMax + cyl.length <= this.H) {
             const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
             if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push(this.createBoxFromPlaced(placedCyl));
                stacked = true;
                break;
             }
          }
        }


      if (stacked) continue;

      // 2. Try Floor Placement (Grid Search)
        // Tight packing: Scan Y then X.
        const tryPlace = (step: number) => {
            for (let y = 0; y + cyl.diameter <= this.L; y += step) {
                for (let x = 0; x + cyl.diameter <= this.W; x += step) {
                    const pos = { x, y, z: 0 };
                    if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                        return pos;
                    }
                }
            }
            return null;
        };

        // Use step=1 for vertical placement to ensure tightest packing
        const bestPos = tryPlace(1);

        if (bestPos) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, bestPos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push(this.createBoxFromPlaced(placedCyl));
        }
    }

    // --- PHASE 2: HORIZONTALS (ATTIC) ---
    const horizontalCandidates = allCylinders.filter(c => !c.placed).sort((a, b) => b.diameter - a.diameter);

    for (const cyl of horizontalCandidates) {
       let bestSpot: { x: number, y: number, z: number } | null = null;

       // Scan Y, X
       for (let y = 0; y + cyl.length <= this.L; y += 2) {
           for (let x = 0; x + cyl.diameter <= this.W; x += 2) {
               const z = this.calculateDropZ(x, y, cyl.diameter, cyl.length, 'horizontal-y', placedBoxes);
               if (z !== null && z + cyl.diameter <= this.H) {
                   bestSpot = { x, y, z };
                   break;
               }
           }
           if (bestSpot) break;
       }

       // Try Rotated (Horizontal-X)?
       if (!bestSpot && cyl.length <= this.W) {
           for (let y = 0; y + cyl.diameter <= this.L; y += 5) {
               for (let x = 0; x + cyl.length <= this.W; x += 5) {
                   const z = this.calculateDropZ(x, y, cyl.diameter, cyl.length, 'horizontal-x', placedBoxes);
                   if (z !== null && z + cyl.diameter <= this.H) {
                        const placedCyl = this.createRotatedPlacedCylinder(cyl, {x, y, z});
                        placed.push(placedCyl);
                        cyl.placed = true;
                        placedBoxes.push(this.createBoxFromPlaced(placedCyl));
                        bestSpot = {x,y,z};
                        break;
                   }
               }
               if (bestSpot) break;
           }
       } else if (bestSpot) {
            const placedCyl = this.createPlacedCylinder(cyl, bestSpot);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push(this.createBoxFromPlaced(placedCyl));
       }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  // --- REUSED HELPERS FROM PREVIOUS VERSION (Restored) ---

  /**
   * Calculates the Z height where a horizontal cylinder would settle (Drop Logic).
   */
  private calculateDropZ(
    x: number, y: number,
    diameter: number, length: number,
    orientation: 'horizontal-y' | 'horizontal-x',
    placedBoxes: PlacedBox[]
  ): number | null {
      const radius = diameter / 2;
      const cx = (orientation === 'horizontal-y') ? x + radius : x + length / 2;
      const cy = (orientation === 'horizontal-y') ? y + length / 2 : y + radius;

      let maxZ = 0; // Floor

      for (const box of placedBoxes) {
          const myXMax = (orientation === 'horizontal-y') ? x + diameter : x + length;
          const myYMax = (orientation === 'horizontal-y') ? y + length : y + diameter;

          if (x >= box.xMax || myXMax <= box.xMin) continue;
          if (y >= box.yMax || myYMax <= box.yMin) continue;

          if (box.orientation === 'vertical') {
              // Sit on flat top
              if (box.zMax > maxZ) maxZ = box.zMax;
          }
          else {
              // Cylinder-on-Cylinder nesting
              const boxIsRotated = box.orientation === 'horizontal-x';
              const boxR = (boxIsRotated ? (box.yMax - box.yMin) : (box.xMax - box.xMin)) / 2;
              const boxCx = box.xMin + (boxIsRotated ? (box.xMax - box.xMin)/2 : boxR);
              const boxCz = box.zMin + boxR;

              if (orientation !== box.orientation) {
                  // Cross stacking -> sits on peak
                  if (box.zMax > maxZ) maxZ = box.zMax;
              } else {
                  // Parallel stacking -> Nesting
                  let distPerp = 0;
                  if (orientation === 'horizontal-y') {
                      distPerp = Math.abs(cx - boxCx);
                  } else {
                      const boxCy = box.yMin + boxR;
                      distPerp = Math.abs(cy - boxCy);
                  }

                  const sumRadii = radius + boxR;
                  if (distPerp < sumRadii) {
                      const dz = Math.sqrt(sumRadii*sumRadii - distPerp*distPerp);
                      const requiredCenterZ = boxCz + dz;
                      const requiredBottomZ = requiredCenterZ - radius;
                      if (requiredBottomZ > maxZ) {
                          maxZ = requiredBottomZ;
                      }
                  }
              }
          }
      }

      return maxZ;
  }

  private canPlaceVertical(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const EPS = 0.1;

    if (x < -EPS || x + diameter > this.W + EPS) return false;
    if (y < -EPS || y + diameter > this.L + EPS) return false;
    if (z < -EPS || z + length > this.H + EPS) return false;

    const cx = x + radius;
    const cy = y + radius;

    for (const box of placed) {
      if (z >= box.zMax || z + length <= box.zMin) continue;

      const isVerticalBox = box.orientation === 'vertical';

      if (isVerticalBox) {
        const boxW = box.xMax - box.xMin;
        const otherR = boxW / 2;
        const otherCx = box.xMin + otherR;
        const otherCy = box.yMin + otherR;

        const dx = cx - otherCx;
        const dy = cy - otherCy;
        const distSq = dx * dx + dy * dy;
        const minDist = radius + otherR - 1;

        if (distSq < minDist * minDist) return false;
      } else {
        // Vertical vs Horizontal Box
        // Check Bounding Box overlap first
        if (x >= box.xMax || x + diameter <= box.xMin) continue;
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        return false;
      }
    }
    return true;
  }

  // --- OTHER STRATEGIES (Condensed for brevity, relying on common helpers if possible) ---

  private packVerticalPriority(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
     // This strategy prioritizes vertical placement but separates candidates into "Can Stack" vs "Cannot"
     allCylinders.forEach(c => c.placed = false);
     const placed: PlacedCylinder[] = [];
     const placedBoxes: PlacedBox[] = [];

     const canBeVertical = allCylinders.filter(c => c.length <= this.H);
     // Sort: Shortest first (stackable), then Largest Diameter
     canBeVertical.sort((a, b) => {
         const aStack = a.length * 2 <= this.H;
         const bStack = b.length * 2 <= this.H;
         if (aStack !== bStack) return bStack ? 1 : -1;
         return b.diameter - a.diameter;
     });

     // Place Verticals
     for (const cyl of canBeVertical) {
         if (cyl.placed) continue;
         // Try floor
          for (let y = 0; y + cyl.diameter <= this.L; y += 1) {
            for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
                const pos = {x,y,z:0};
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const p = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(p);
                    placedBoxes.push(this.createBoxFromPlaced(p));
                    cyl.placed = true;
                    // Break both loops
                    y = this.L; x = this.W;
                }
            }
          }
     }

     // Fill rest with Horizontals (Aggressive)
     this.runAggressivePass(allCylinders, placedBoxes, placed);

     return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private packMixedOrientations(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      // Sort by Volume Desc
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort((a,b) => (b.diameter*b.diameter*b.length) - (a.diameter*a.diameter*a.length));

      const placed: PlacedCylinder[] = [];
      const placedBoxes: PlacedBox[] = [];

      for(const cyl of sorted) {
          // Try both orientations, pick lowest Z
          let bestPos = null;
          let bestOrientation = '';
          let minZ = Infinity;

          // Try Vertical
          if (cyl.length <= this.H) {
               // Quick grid search
               for (let y = 0; y + cyl.diameter <= this.L; y += 5) {
                   for(let x=0; x+cyl.diameter <= this.W; x += 5) {
                       const pos = {x,y,z:0};
                       if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                           if (pos.z < minZ) { minZ = pos.z; bestPos = pos; bestOrientation = 'vertical'; }
                           // floor found
                           y=this.L; x=this.W;
                       }
                   }
               }
          }

          // Try Horizontal (Gravity Drop)
          // ... (Using aggressive pass logic effectively)
          // For simplicity in this strategy, we use the helper logic directly
          // We'll skip complex comparison and just try Aggressive Placement for this single item
          // but we want to know WHICH is better.

          // Just run aggressive placement immediately for this item
          const res = this.tryAggressivePlacement(cyl, placedBoxes);
          if (res) {
               if (res.pos.z < minZ) {
                   if (res.orientation === 'vertical') {
                        const p = this.createVerticalPlacedCylinder(cyl, res.pos);
                        placed.push(p);
                        placedBoxes.push(this.createBoxFromPlaced(p));
                        cyl.placed = true;
                   } else if (res.orientation === 'horizontal-y') {
                        const p = this.createPlacedCylinder(cyl, res.pos);
                        placed.push(p);
                        placedBoxes.push(this.createBoxFromPlaced(p));
                        cyl.placed = true;
                   } else {
                        const p = this.createRotatedPlacedCylinder(cyl, res.pos);
                        placed.push(p);
                        placedBoxes.push(this.createBoxFromPlaced(p));
                        cyl.placed = true;
                   }
               }
          }
      }

      return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private packLargestFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      // Sort by Diameter Desc
      const sorted = [...allCylinders].sort((a,b) => b.diameter - a.diameter);

      const placed: PlacedCylinder[] = [];
      const placedBoxes: PlacedBox[] = [];

      // Greedy placement
      for(const cyl of sorted) {
          const res = this.tryAggressivePlacement(cyl, placedBoxes);
          if (res) {
             if (res.orientation === 'vertical') {
                const p = this.createVerticalPlacedCylinder(cyl, res.pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;
             } else if (res.orientation === 'horizontal-y') {
                const p = this.createPlacedCylinder(cyl, res.pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;
             } else {
                const p = this.createRotatedPlacedCylinder(cyl, res.pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;
             }
          }
      }
      return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private packByPerfectColumns(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
     allCylinders.forEach(c => c.placed = false);
     const placed: PlacedCylinder[] = [];
     const placedBoxes: PlacedBox[] = [];

     // 1. Group by exact diameter
     const groups = new Map<number, Cylinder[]>();
     for(const c of allCylinders) {
         if (!groups.has(c.diameter)) groups.set(c.diameter, []);
         groups.get(c.diameter)!.push(c);
     }

     // 2. Calculate efficiency
     const groupData: { diameter: number; efficiency: number; cylinders: Cylinder[]; cols: number }[] = [];
     for(const [d, cyls] of groups.entries()) {
         const cols = Math.floor(this.W / d);
         const efficiency = (cols * d) / this.W;
         groupData.push({ diameter: d, efficiency, cylinders: cyls, cols });
     }

     // 3. Sort by Efficiency Descending (High efficiency groups first)
     //    Tie-breaker: Number of items (larger groups first)
     groupData.sort((a,b) => {
         if (Math.abs(b.efficiency - a.efficiency) > 0.05) return b.efficiency - a.efficiency;
         return b.cylinders.length - a.cylinders.length;
     });

     let currentY = 0;

     for(const group of groupData) {
         const { diameter, cylinders, cols } = group;
         if (cols === 0) continue; // Too big?

         // Sort cylinders in group: Height Descending (to create flat tops if possible)
         cylinders.sort((a,b) => b.length - a.length);

         // Pack in columns
         // We fill row by row

         const rowCount = Math.ceil(cylinders.length / cols);

         // Check if we have enough length left?
         // We do this dynamically.

         let placedInGroup = 0;
         let groupMaxY = currentY;

         // Iterate rows
         let currentRowY = currentY;
         let colIndex = 0;
         let rowIndex = 0;

         for(const cyl of cylinders) {
             if (cyl.placed) continue;
             if (cyl.length > this.H) continue; // Skip non-verticals for this phase (or handle them?)
             // Actually this strategy is primarily for Vertical Floor packing.

             // Calc position
             const x = colIndex * diameter;
             const y = currentRowY;

             if (y + diameter > this.L) break; // Container full

             const pos = { x, y, z: 0 };
             if (this.canPlaceVertical(pos, diameter, cyl.length, placedBoxes)) {
                 const p = this.createVerticalPlacedCylinder(cyl, pos);
                 placed.push(p);
                 placedBoxes.push(this.createBoxFromPlaced(p));
                 cyl.placed = true;
                 placedInGroup++;

                 groupMaxY = Math.max(groupMaxY, y + diameter);
             }

             colIndex++;
             if (colIndex >= cols) {
                 colIndex = 0;
                 currentRowY += diameter; // Advance row
                 rowIndex++;
             }
         }

         // Update currentY to the end of this block
         // But only if we placed something significant.
         // Actually, since we pack sequentially, we can just set currentY to the max Y used.
         // But we might have gaps if we filtered non-verticals.

         currentY = groupMaxY;
     }

     // 4. Fill remaining space (and unplaced items) with Aggressive Pass
     //    (Horizontals on top, or filling gaps)
     this.runAggressivePass(allCylinders, placedBoxes, placed);

     return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  // --- PRIMITIVES ---

  private tryAggressivePlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
    const { diameter, length } = cyl;

    // Collect ALL Z levels
    const zLevels: number[] = [0];
    for (const box of placedBoxes) {
      if (!zLevels.includes(box.zMax)) zLevels.push(box.zMax);
    }
    zLevels.sort((a, b) => a - b);

    // 1. Try horizontal-Y at EVERY Z level
    for (const z of zLevels) {
      if (z + diameter > this.H) continue;
      // Scan floor tightly
      for (let y = 0; y + length <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
             // Check stability
             if (z === 0 || this.calculateDropZ(x, y, diameter, length, 'horizontal-y', placedBoxes) !== null) {
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
             // Use canPlaceRotated logic (embedded or separate)
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
                if (z === 0 || this.calculateDropZ(x, y, diameter, length, 'horizontal-x', placedBoxes) !== null) {
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
               return { pos, orientation: 'vertical' };
            }
          }
        }
      }
    }

    return null;
  }

  // Helper for canPlace (Horizontal-Y)
  private canPlace(pos: { x: number; y: number; z: number }, diameter: number, length: number, placed: PlacedBox[]): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cx = x + radius;
    const cz = z + radius;
    const EPS = 0.1;

    if (x < -EPS || x + diameter > this.W + EPS) return false;
    if (y < -EPS || y + length > this.L + EPS) return false;
    if (z < -EPS || z + diameter > this.H + EPS) return false;

    for (const box of placed) {
      if (y >= box.yMax || y + length <= box.yMin) continue; // No Y overlap

      if (box.orientation === 'vertical') {
         // Horizontal Y vs Vertical
         if (x >= box.xMax || x + diameter <= box.xMin) continue;
         if (z >= box.zMax) continue; // Resting on top is fine (handled by DropZ), but inside is not
         if (z + diameter <= box.zMin) continue;
         // Collision
         return false;
      } else if (box.orientation === 'horizontal-x') {
         // Cross collision
         if (x >= box.xMax || x + diameter <= box.xMin) continue;
         if (z >= box.zMax || z + diameter <= box.zMin) continue;
         return false;
      } else {
         // Parallel
         const otherR = (box.xMax - box.xMin) / 2;
         const otherCx = box.xMin + otherR;
         const otherCz = box.zMin + otherR;
         const distSq = (cx - otherCx)**2 + (cz - otherCz)**2;
         const minDist = radius + otherR - 1;
         if (distSq < minDist**2) return false;
      }
    }
    return true;
  }

  // Helper for canPlaceRotated (Horizontal-X)
  private canPlaceRotated(pos: { x: number; y: number; z: number }, diameter: number, length: number, placed: PlacedBox[]): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cy = y + radius;
    const cz = z + radius;
    const EPS = 0.1;

    if (x < -EPS || x + length > this.W + EPS) return false;
    if (y < -EPS || y + diameter > this.L + EPS) return false;
    if (z < -EPS || z + diameter > this.H + EPS) return false;

    for (const box of placed) {
      if (x >= box.xMax || x + length <= box.xMin) continue; // No X overlap

      if (box.orientation === 'vertical') {
         if (y >= box.yMax || y + diameter <= box.yMin) continue;
         if (z >= box.zMax || z + diameter <= box.zMin) continue;
         return false;
      } else if (box.orientation === 'horizontal-y') {
         // Cross collision
         if (y >= box.yMax || y + diameter <= box.yMin) continue;
         if (z >= box.zMax || z + diameter <= box.zMin) continue;
         return false;
      } else {
         // Parallel
         const otherR = (box.yMax - box.yMin) / 2;
         const otherCy = box.yMin + otherR;
         const otherCz = box.zMin + otherR;
         const distSq = (cy - otherCy)**2 + (cz - otherCz)**2;
         const minDist = radius + otherR - 1;
         if (distSq < minDist**2) return false;
      }
    }
    return true;
  }

  // --- FACTORIES ---
  private createVerticalPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    return {
      item: cyl.item, uniqueId: `cyl_${cyl.index}_v`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: { x: pos.x + radius, y: pos.y + radius, z: pos.z + cyl.length / 2 },
      radius, length: cyl.length, orientation: 'vertical',
      rotation: ORIENTATION_ROTATIONS['vertical'], layerId: 0, supportedBy: [],
    };
  }

  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    return {
      item: cyl.item, uniqueId: `cyl_${cyl.index}_h`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: { x: pos.x + radius, y: pos.y + cyl.length / 2, z: pos.z + radius },
      radius, length: cyl.length, orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'], layerId: 0, supportedBy: [],
    };
  }

  private createRotatedPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    return {
      item: cyl.item, uniqueId: `cyl_${cyl.index}_r`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: { x: pos.x + cyl.length / 2, y: pos.y + radius, z: pos.z + radius },
      radius, length: cyl.length, orientation: 'horizontal-x',
      rotation: ORIENTATION_ROTATIONS['horizontal-x'], layerId: 0, supportedBy: [],
    };
  }

  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
      let vol = 0;
      placed.forEach(p => vol += Math.PI * p.radius**2 * p.length);
      return {
          totalVolumePlaced: vol,
          containerVolumeUsed: this.W*this.L*this.H,
          volumeEfficiency: vol / (this.W*this.L*this.H),
          layerCount: 1, itemsPlaced: placed.length, itemsFailed: failed
      };
  }

  private emptyResult(): CoilSolverResult {
    return { placedCylinders: [], unplacedItems: [], statistics: { totalVolumePlaced: 0, containerVolumeUsed: 0, volumeEfficiency: 0, layerCount: 0, itemsPlaced: 0, itemsFailed: 0 } };
  }
}
