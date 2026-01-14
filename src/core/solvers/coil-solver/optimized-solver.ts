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

    // --- STRATEGY DEFINITIONS ---
    const strategies = [
      {
        name: 'DifficultFirst',
        fn: () => this.packDifficultFirst(all)
      },
      {
        name: 'TallestFirst',
        fn: () => {
             all.forEach(c => c.placed = false);
             const sorted = [...all].sort((a,b) => b.length - a.length);
             return this.packGreedyStrictOrder(sorted);
        }
      },
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
      {
        name: 'PerfectColumns',
        fn: () => this.packByPerfectColumns(all)
      },
      {
        name: 'PlatformBuilder',
        fn: () => this.packByPlatforms(all)
      },
      {
        name: 'SmallestFirst',
        fn: () => this.packSmallestFirst(all)
      },
      {
        name: 'RandomizedSearch',
        fn: () => this.packRandomized(all)
      }
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; score: number; name: string; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
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
        break;
      }
    }

    if (!bestResult) return this.emptyResult();

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
      let bestLocalResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } = { placed: [], unplaced: [] };
      let bestCount = -1;

      const workingSet = [...allCylinders];
      const startTime = Date.now();
      const TIME_LIMIT_MS = 15000; // 15 seconds max

      for(let i=0; i<100; i++) {
          if (Date.now() - startTime > TIME_LIMIT_MS) break;

          let currentResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] };

          if (i < 20) {
             this.shuffle(workingSet);
             workingSet.forEach(c => c.placed = false);
             currentResult = this.packGreedyStrictOrder(workingSet);
          } else if (i < 50) {
             // Smart Shuffle: Sort by Volume Desc
             workingSet.sort((a,b) => (b.diameter**2 * b.length) - (a.diameter**2 * a.length));

             const keepCount = Math.floor(workingSet.length * 0.3);
             const fixedPart = workingSet.slice(0, keepCount);
             const shufflePart = workingSet.slice(keepCount);
             this.shuffle(shufflePart);

             workingSet.length = 0;
             workingSet.push(...fixedPart, ...shufflePart);

             workingSet.forEach(c => c.placed = false);
             currentResult = this.packGreedyStrictOrder(workingSet);
          } else if (i < 80) {
             // Priority Shuffle: Difficult items first
             const difficult = [];
             const easy = [];
             for(const c of workingSet) {
                 if (c.length / c.diameter > 1.8) difficult.push(c);
                 else easy.push(c);
             }
             this.shuffle(difficult);
             this.shuffle(easy);
             workingSet.length = 0;
             workingSet.push(...difficult, ...easy);

             workingSet.forEach(c => c.placed = false);
             currentResult = this.packGreedyStrictOrder(workingSet);
          } else {
             // Reverse Volume
             workingSet.sort((a,b) => (a.diameter**2 * a.length) - (b.diameter**2 * b.length));
             this.shuffle(workingSet);

             const keepCount = Math.floor(workingSet.length * 0.3);
             const fixedPart = workingSet.slice(0, keepCount);
             const shufflePart = workingSet.slice(keepCount);
             this.shuffle(shufflePart);

             workingSet.length = 0;
             workingSet.push(...fixedPart, ...shufflePart);

             workingSet.forEach(c => c.placed = false);
             currentResult = this.packGreedyStrictOrder(workingSet);
          }

           const pBoxes = currentResult.placed.map(p => this.createBoxFromPlaced(p));
           this.runAggressivePass(workingSet, pBoxes, currentResult.placed);
           const totalPlaced = currentResult.placed.length;

           if (totalPlaced > bestCount) {
               bestCount = totalPlaced;
               bestLocalResult = {
                   placed: [...currentResult.placed], // Clone the placed array
                   unplaced: workingSet.filter(c => !c.placed).map(c => c.item)
               };
               if (totalPlaced === allCylinders.length) break;
           }
      }

      allCylinders.forEach(c => c.placed = false);
      const placedIndices = new Set<number>();
      for (const p of bestLocalResult.placed) {
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

          // Try Vertical first
          if (cyl.length <= this.H) {
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

      // OPTIMIZATION: Sort by Volume Descending (Largest First) to pack big items into attic first.
      // Falls back to diameter if volumes similar.
      unplaced.sort((a,b) => {
          const volA = a.diameter * a.diameter * a.length;
          const volB = b.diameter * b.diameter * b.length;
          return volB - volA;
      });

      for (const cyl of unplaced) {
        const result = this.tryAggressivePlacement(cyl, placedBoxes);
        if (result) {
             // Strict check bounds - redundant but safe
             const EPS = 0.001;
             let fits = true;

             const box: any = {};
             if (result.orientation === 'horizontal-x') {
                 box.xMax = result.pos.x + cyl.length; box.yMax = result.pos.y + cyl.diameter; box.zMax = result.pos.z + cyl.diameter;
             } else if (result.orientation === 'vertical') {
                 box.xMax = result.pos.x + cyl.diameter; box.yMax = result.pos.y + cyl.diameter; box.zMax = result.pos.z + cyl.length;
             } else {
                 box.xMax = result.pos.x + cyl.diameter; box.yMax = result.pos.y + cyl.length; box.zMax = result.pos.z + cyl.diameter;
             }

             if (result.pos.x < -EPS || box.xMax > this.W + EPS) fits = false;
             if (result.pos.y < -EPS || box.yMax > this.L + EPS) fits = false;
             if (result.pos.z < -EPS || box.zMax > this.H + EPS) fits = false;

             if (!fits) continue;

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
        }
      }
      return added;
  }

  // --- STRATEGIES ---

  private packDifficultFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      // Sort by Volume (Size) Descending - Biggest rocks first!
      // But prioritize Length > Height (must be vertical)
      const sorted = [...allCylinders].sort((a,b) => {
          // If one is tall (>200) and other is not, prioritize tall?
          // No, 160 is the tallest here.
          // Prioritize by Volume strictly.
          const volA = a.diameter * a.diameter * a.length;
          const volB = b.diameter * b.diameter * b.length;
          return volB - volA;
      });
      return this.packGreedyStrictOrder(sorted);
  }

  private packHumanLogic(allCylinders: Cylinder[], sortMode: 'height-desc' | 'diameter-desc'): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);
    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // --- PHASE 1: VERTICALS ---
    const verticalCandidates = [...allCylinders].sort((a, b) => {
        if (sortMode === 'height-desc') {
             if (Math.abs(b.length - a.length) > 1) return b.length - a.length;
             return b.diameter - a.diameter;
        } else {
             if (Math.abs(b.diameter - a.diameter) > 1) return b.diameter - a.diameter;
             return b.length - a.length;
        }
    });

    for (const cyl of verticalCandidates) {
      if (cyl.placed) continue;
      if (cyl.length > this.H) continue;

      // 1. Try to Stack
      let stacked = false;
      for (const box of placedBoxes) {
          if (box.orientation !== 'vertical') continue;
          const boxW = box.xMax - box.xMin;
          if (Math.abs(boxW - cyl.diameter) > 2) continue; // Similar diameter

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

      // 2. Try Floor
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
    this.runAggressivePass(horizontalCandidates, placedBoxes, placed);

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  // --- PRIMITIVES (FIXED) ---

  /**
   * Calculates the Z height where a horizontal cylinder would settle (Drop Logic).
   * STRICT NO-OVERLAP TOLERANCE.
   */
  private calculateDropZ(
    x: number, y: number,
    diameter: number, length: number,
    orientation: 'horizontal-y' | 'horizontal-x',
    placedBoxes: PlacedBox[]
  ): number {
      const radius = diameter / 2;
      const cx = (orientation === 'horizontal-y') ? x + radius : x + length / 2;
      const cy = (orientation === 'horizontal-y') ? y + length / 2 : y + radius;

      let maxZ = 0; // Floor
      const EPS = 0.0001; // Tiny tolerance for floating point comparison only

      for (const box of placedBoxes) {
          const myXMax = (orientation === 'horizontal-y') ? x + diameter : x + length;
          const myYMax = (orientation === 'horizontal-y') ? y + length : y + diameter;

          if (x >= box.xMax - EPS || myXMax <= box.xMin + EPS) continue;
          if (y >= box.yMax - EPS || myYMax <= box.yMin + EPS) continue;

          if (box.orientation === 'vertical') {
              // Sit on flat top
              if (box.zMax > maxZ) maxZ = box.zMax;
          }
          else {
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
                  // Strict Check: No -1 tolerance!
                  if (distPerp < sumRadii - EPS) {
                      const dz = Math.sqrt(Math.max(0, sumRadii*sumRadii - distPerp*distPerp));
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
    const EPS = 0.001;

    if (x < -EPS || x + diameter > this.W + EPS) return false;
    if (y < -EPS || y + diameter > this.L + EPS) return false;
    if (z < -EPS || z + length > this.H + EPS) return false;

    const cx = x + radius;
    const cy = y + radius;

    for (const box of placed) {
      if (z >= box.zMax - EPS || z + length <= box.zMin + EPS) continue;

      const isVerticalBox = box.orientation === 'vertical';

      if (isVerticalBox) {
        const boxW = box.xMax - box.xMin;
        const otherR = boxW / 2;
        const otherCx = box.xMin + otherR;
        const otherCy = box.yMin + otherR;

        const dx = cx - otherCx;
        const dy = cy - otherCy;
        const distSq = dx * dx + dy * dy;
        const minDist = radius + otherR - EPS; // Strict check

        if (distSq < minDist * minDist) return false;
      } else {
        // Vertical vs Horizontal Box
        // Check Bounding Box overlap first
        if (x >= box.xMax - EPS || x + diameter <= box.xMin + EPS) continue;
        if (y >= box.yMax - EPS || y + diameter <= box.yMin + EPS) continue;
        return false;
      }
    }
    return true;
  }

  private canPlace(pos: { x: number; y: number; z: number }, diameter: number, length: number, placed: PlacedBox[]): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cx = x + radius;
    const cz = z + radius;
    const EPS = 0.001;

    if (x < -EPS || x + diameter > this.W + EPS) return false;
    if (y < -EPS || y + length > this.L + EPS) return false;
    if (z < -EPS || z + diameter > this.H + EPS) return false;

    for (const box of placed) {
      if (y >= box.yMax - EPS || y + length <= box.yMin + EPS) continue;

      if (box.orientation === 'vertical') {
         if (x >= box.xMax - EPS || x + diameter <= box.xMin + EPS) continue;
         if (z >= box.zMax - EPS) continue;
         if (z + diameter <= box.zMin + EPS) continue;
         return false;
      } else if (box.orientation === 'horizontal-x') {
         if (x >= box.xMax - EPS || x + diameter <= box.xMin + EPS) continue;
         if (z >= box.zMax - EPS || z + diameter <= box.zMin + EPS) continue;
         return false;
      } else {
         const otherR = (box.xMax - box.xMin) / 2;
         const otherCx = box.xMin + otherR;
         const otherCz = box.zMin + otherR;
         const distSq = (cx - otherCx)**2 + (cz - otherCz)**2;
         const minDist = radius + otherR - EPS; // Strict
         if (distSq < minDist**2) return false;
      }
    }
    return true;
  }

  private canPlaceRotated(pos: { x: number; y: number; z: number }, diameter: number, length: number, placed: PlacedBox[]): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cy = y + radius;
    const cz = z + radius;
    const EPS = 0.001;

    if (x < -EPS || x + length > this.W + EPS) return false;
    if (y < -EPS || y + diameter > this.L + EPS) return false;
    if (z < -EPS || z + diameter > this.H + EPS) return false;

    for (const box of placed) {
      if (x >= box.xMax - EPS || x + length <= box.xMin + EPS) continue;

      if (box.orientation === 'vertical') {
         if (y >= box.yMax - EPS || y + diameter <= box.yMin + EPS) continue;
         if (z >= box.zMax - EPS || z + diameter <= box.zMin + EPS) continue;
         return false;
      } else if (box.orientation === 'horizontal-y') {
         if (y >= box.yMax - EPS || y + diameter <= box.yMin + EPS) continue;
         if (z >= box.zMax - EPS || z + diameter <= box.zMin + EPS) continue;
         return false;
      } else {
         const otherR = (box.yMax - box.yMin) / 2;
         const otherCy = box.yMin + otherR;
         const otherCz = box.zMin + otherR;
         const distSq = (cy - otherCy)**2 + (cz - otherCz)**2;
         const minDist = radius + otherR - EPS; // Strict
         if (distSq < minDist**2) return false;
      }
    }
    return true;
  }

  // REWRITTEN AGGRESSIVE PLACEMENT (Candidate Points - Fast & Precise)
  private tryAggressivePlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
    const { diameter, length } = cyl;

    // Generate Candidate Points (Snap to existing edges)
    // This is much faster than Grid Scan and precise for "Perfect Fits".

    const xCandidates = new Set<number>();
    xCandidates.add(0);
    const yCandidates = new Set<number>();
    yCandidates.add(0);

    for(const b of placedBoxes) {
        if (b.xMax <= this.W) xCandidates.add(b.xMax);
        if (b.yMax <= this.L) yCandidates.add(b.yMax);
    }

    const sortedX = Array.from(xCandidates).sort((a,b) => a-b);
    const sortedY = Array.from(yCandidates).sort((a,b) => a-b);

    // --- 1. Floor Priority (Vertical & Horizontal) ---
    // Check floor spots first (z=0)

    // 1a. Vertical Floor
    if (length <= this.H) {
         for (const y of sortedY) {
             if (y + diameter > this.L) break;
             for(const x of sortedX) {
                 if (x + diameter > this.W) break;

                 const pos = { x, y, z: 0 };
                 if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                      return { pos, orientation: 'vertical' };
                 }
             }
         }
    }

    // 1b. Horizontal-Y Floor
    for (const y of sortedY) {
        if (y + length > this.L) break;
        for (const x of sortedX) {
             if (x + diameter > this.W) break;
             const pos = { x, y, z: 0 };
             if (this.canPlace(pos, diameter, length, placedBoxes)) {
                  return { pos, orientation: 'horizontal-y' };
             }
        }
    }

    // 1c. Horizontal-X Floor
    if (length <= this.W) {
        for (const y of sortedY) {
            if (y + diameter > this.L) break;
            for (const x of sortedX) {
                if (x + length > this.W) break;
                const pos = { x, y, z: 0 };
                if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
                    return { pos, orientation: 'horizontal-x' };
                }
            }
        }
    }

    // --- 2. Stack / Attic (Gravity) ---
    // Scan candidates again, but calculate DropZ.

    let bestSol: { pos: { x: number, y: number, z: number }, orientation: any, z: number } | null = null;

    // We can use a coarse grid for DropZ to find "nesting" spots that don't align with edges?
    // Nesting often happens at (x1 + x2)/2.
    // But let's try Candidate Points first. If we only snap to edges, we maximize "Shelf" usage.
    // For "Honeycomb", we might miss the optimal valley.
    // BUT, finding *some* spot is better than timeout.
    // Let's stick to sortedX/sortedY for now.

    // 2a. Horizontal-Y Stack
    for (const y of sortedY) {
        if (y + length > this.L) break;
        for (const x of sortedX) {
            if (x + diameter > this.W) break;

            const z = this.calculateDropZ(x, y, diameter, length, 'horizontal-y', placedBoxes);
            if (z > 0 && z + diameter <= this.H) {
                const pos = { x, y, z };
                if (this.canPlace(pos, diameter, length, placedBoxes)) {
                    if (!bestSol || z < bestSol.z) {
                        bestSol = { pos, orientation: 'horizontal-y', z };
                    }
                }
            }
        }
    }

    // 2b. Horizontal-X Stack
    if (length <= this.W) {
        for (const y of sortedY) {
            if (y + diameter > this.L) break;
            for (const x of sortedX) {
                if (x + length > this.W) break;

                const z = this.calculateDropZ(x, y, diameter, length, 'horizontal-x', placedBoxes);
                if (z > 0 && z + diameter <= this.H) {
                    const pos = { x, y, z };
                    if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
                        if (!bestSol || z < bestSol.z) {
                            bestSol = { pos, orientation: 'horizontal-x', z };
                        }
                    }
                }
            }
        }
    }

    // 2c. Vertical Stack
    if (length <= this.H) {
         for(const box of placedBoxes) {
             if(box.orientation === 'vertical' && box.zMax + length <= this.H) {
                 const boxW = box.xMax - box.xMin;
                 if (Math.abs(boxW - diameter) < 2) {
                     const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
                     if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                          if (!bestSol || pos.z < bestSol.z) {
                              bestSol = { pos, orientation: 'vertical', z: pos.z };
                          }
                     }
                 }
             }
         }
    }

    if (bestSol) {
        return { pos: bestSol.pos, orientation: bestSol.orientation };
    }
    return null;
  }

  // Strategies Implementation (Shortened for brevity as they call helpers)

  private packVerticalPriority(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
     allCylinders.forEach(c => c.placed = false);
     const placed: PlacedCylinder[] = [];
     const placedBoxes: PlacedBox[] = [];

     const canBeVertical = allCylinders.filter(c => c.length <= this.H);
     canBeVertical.sort((a, b) => {
         const aStack = a.length * 2 <= this.H;
         const bStack = b.length * 2 <= this.H;
         if (aStack !== bStack) return bStack ? 1 : -1;
         return b.diameter - a.diameter;
     });

     for (const cyl of canBeVertical) {
         if (cyl.placed) continue;
          for (let y = 0; y + cyl.diameter <= this.L; y += 1) {
            for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
                const pos = {x,y,z:0};
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const p = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(p);
                    placedBoxes.push(this.createBoxFromPlaced(p));
                    cyl.placed = true;
                    y = this.L; x = this.W;
                }
            }
          }
     }

     this.runAggressivePass(allCylinders, placedBoxes, placed);
     return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private packMixedOrientations(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort((a,b) => (b.diameter*b.diameter*b.length) - (a.diameter*a.diameter*a.length));
      return this.packGreedyStrictOrder(sorted);
  }

  private packLargestFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort((a,b) => b.diameter - a.diameter);
      return this.packGreedyStrictOrder(sorted);
  }

  private packSmallestFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort((a,b) => a.diameter - b.diameter);
      return this.packGreedyStrictOrder(sorted);
  }

  private packByPerfectColumns(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
     allCylinders.forEach(c => c.placed = false);
     const placed: PlacedCylinder[] = [];
     const placedBoxes: PlacedBox[] = [];

     const groups = new Map<number, Cylinder[]>();
     for(const c of allCylinders) {
         if (!groups.has(c.diameter)) groups.set(c.diameter, []);
         groups.get(c.diameter)!.push(c);
     }

     const groupData: { diameter: number; efficiency: number; cylinders: Cylinder[]; cols: number }[] = [];
     for(const [d, cyls] of groups.entries()) {
         const cols = Math.floor(this.W / d);
         const efficiency = (cols * d) / this.W;
         groupData.push({ diameter: d, efficiency, cylinders: cyls, cols });
     }

     groupData.sort((a,b) => {
         if (Math.abs(b.efficiency - a.efficiency) > 0.05) return b.efficiency - a.efficiency;
         return b.cylinders.length - a.cylinders.length;
     });

     let currentY = 0;

     for(const group of groupData) {
         const { diameter, cylinders, cols } = group;
         if (cols === 0) continue;

         cylinders.sort((a,b) => b.length - a.length);
         let groupMaxY = currentY;
         let colIndex = 0;
         let currentRowY = currentY;

         for(const cyl of cylinders) {
             if (cyl.placed) continue;
             if (cyl.length > this.H) continue;

             const x = colIndex * diameter;
             const y = currentRowY;

             if (y + diameter > this.L) break;

             const pos = { x, y, z: 0 };
             if (this.canPlaceVertical(pos, diameter, cyl.length, placedBoxes)) {
                 const p = this.createVerticalPlacedCylinder(cyl, pos);
                 placed.push(p);
                 placedBoxes.push(this.createBoxFromPlaced(p));
                 cyl.placed = true;

                 groupMaxY = Math.max(groupMaxY, y + diameter);
             }

             colIndex++;
             if (colIndex >= cols) {
                 colIndex = 0;
                 currentRowY += diameter;
             }
         }
         currentY = groupMaxY;
     }

     this.runAggressivePass(allCylinders, placedBoxes, placed);
     return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private packByPlatforms(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
     allCylinders.forEach(c => c.placed = false);
     const placed: PlacedCylinder[] = [];
     const placedBoxes: PlacedBox[] = [];

     const heightGroups = new Map<number, Cylinder[]>();
     for(const c of allCylinders) {
         if (c.length > this.H) continue;
         const hKey = Math.floor(c.length / 2) * 2;
         if (!heightGroups.has(hKey)) heightGroups.set(hKey, []);
         heightGroups.get(hKey)!.push(c);
     }

     const groupList = Array.from(heightGroups.entries()).map(([h, list]) => ({
         height: h,
         list,
     })).sort((a,b) => b.height - a.height);

     let currentY = 0;
     for(const group of groupList) {
         group.list.sort((a,b) => b.diameter - a.diameter);
         let rowY = currentY;
         let rowH = 0;
         let rowX = 0;

         for(const cyl of group.list) {
             if (cyl.placed) continue;

             if (rowX + cyl.diameter > this.W) {
                 rowY += rowH;
                 rowX = 0;
                 rowH = 0;
             }

             if (rowY + cyl.diameter > this.L) break;

             const pos = { x: rowX, y: rowY, z: 0 };
             if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                 const p = this.createVerticalPlacedCylinder(cyl, pos);
                 placed.push(p);
                 placedBoxes.push(this.createBoxFromPlaced(p));
                 cyl.placed = true;

                 rowX += cyl.diameter;
                 rowH = Math.max(rowH, cyl.diameter);
             }
         }
         currentY = Math.max(currentY, rowY + rowH);
     }

     this.runAggressivePass(allCylinders, placedBoxes, placed);
     return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  // --- FACTORIES (unchanged logic) ---
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
