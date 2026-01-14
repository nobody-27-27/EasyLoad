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
        name: 'PerfectColumns_Horizontal',
        fn: () => this.packByPerfectColumns(all, 'horizontal')
      },
      {
        name: 'Horizontal_MaxDensity',
        fn: () => this.packHorizontalDominant(all)
      },
      {
        name: 'SmartGrid_LengthDesc',
        fn: () => this.packSmartGrid(all, 'length-desc')
      },
      {
        name: 'SmartGrid_DiamDesc',
        fn: () => this.packSmartGrid(all, 'diameter-desc')
      },
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
        name: 'VerticalPriority',
        fn: () => this.packVerticalPriority(all)
      },
      {
        name: 'MixedOrientations_Volume',
        fn: () => this.packMixedOrientations(all)
      },
      {
        name: 'PerfectColumns',
        fn: () => this.packByPerfectColumns(all, 'vertical')
      },
      {
        name: 'PlatformBuilder',
        fn: () => this.packByPlatforms(all)
      },
      {
        name: 'RandomizedSearch',
        fn: () => this.packRandomized(all)
      }
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; score: number; name: string; placedBoxes: PlacedBox[] } | null = null;

    console.log(`Starting Multi-Strategy Solver for ${all.length} items...`);

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

      // Score: Placed Count * 1000 - Volume Waste
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

    console.log(`Winner: ${bestResult.name} (${bestResult.placed.length}/${all.length})`);

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

  // --- PACKING CORE (Refactored) ---

  private packGreedyStrictOrder(
      cylinders: Cylinder[],
      mode: 'vertical-first' | 'horizontal-first' = 'vertical-first'
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      const placed: PlacedCylinder[] = [];
      const placedBoxes: PlacedBox[] = [];

      for(const cyl of cylinders) {
          if (cyl.placed) continue;

          let res;
          if (mode === 'vertical-first') {
              res = this.findVerticalCandidate(cyl, placedBoxes);
              if (!res) res = this.findHorizontalCandidate(cyl, placedBoxes);
          } else {
              res = this.findHorizontalCandidate(cyl, placedBoxes);
              if (!res) res = this.findVerticalCandidate(cyl, placedBoxes);
          }

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

  private tryAggressivePlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
      // Default: Vertical First
      const v = this.findVerticalCandidate(cyl, placedBoxes);
      if (v) return v;
      return this.findHorizontalCandidate(cyl, placedBoxes);
  }

  // --- PRIMITIVE FINDERS ---

  private findVerticalCandidate(
      cyl: Cylinder,
      placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'vertical' } | null {
      const { diameter, length } = cyl;
      if (length > this.H) return null;

      // Candidate Points
      const xCandidates = new Set<number>(); xCandidates.add(0);
      const yCandidates = new Set<number>(); yCandidates.add(0);
      const zCandidates = new Set<number>(); zCandidates.add(0);

      for(const b of placedBoxes) {
          if (b.xMax <= this.W) xCandidates.add(b.xMax);
          if (b.yMax <= this.L) yCandidates.add(b.yMax);
          if (b.zMax + length <= this.H) zCandidates.add(b.zMax);
      }

      const sortedX = Array.from(xCandidates).sort((a,b) => a-b);
      const sortedY = Array.from(yCandidates).sort((a,b) => a-b);
      const sortedZ = Array.from(zCandidates).sort((a,b) => a-b);

      for(const z of sortedZ) {
         for (const y of sortedY) {
             if (y + diameter > this.L) break;
             for(const x of sortedX) {
                 if (x + diameter > this.W) break;

                 const pos = { x, y, z };
                 if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                      return { pos, orientation: 'vertical' };
                 }
             }
         }
      }
      return null;
  }

  private findHorizontalCandidate(
      cyl: Cylinder,
      placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' } | null {
      const { diameter, length } = cyl;

      const xCandidates = new Set<number>(); xCandidates.add(0);
      const yCandidates = new Set<number>(); yCandidates.add(0);
      for(const b of placedBoxes) {
          if (b.xMax <= this.W) xCandidates.add(b.xMax);
          if (b.yMax <= this.L) yCandidates.add(b.yMax);
      }
      const sortedX = Array.from(xCandidates).sort((a,b) => a-b);
      const sortedY = Array.from(yCandidates).sort((a,b) => a-b);

      let bestSol: { pos: { x: number, y: number, z: number }, orientation: 'horizontal-y' | 'horizontal-x', z: number } | null = null;

      // 1. Horizontal-Y
      for (const y of sortedY) {
          if (y + length > this.L) break;
          for (const x of sortedX) {
              if (x + diameter > this.W) break;

              // Floor First (Optimization)
              const posFloor = { x, y, z: 0 };
              if (this.canPlace(posFloor, diameter, length, placedBoxes)) {
                  if (!bestSol || 0 < bestSol.z) {
                      bestSol = { pos: posFloor, orientation: 'horizontal-y', z: 0 };
                  }
              }

              // Stack
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

      // 2. Horizontal-X
      if (length <= this.W) {
          for (const y of sortedY) {
              if (y + diameter > this.L) break;
              for (const x of sortedX) {
                  if (x + length > this.W) break;

                  // Floor
                  const posFloor = { x, y, z: 0 };
                  if (this.canPlaceRotated(posFloor, diameter, length, placedBoxes)) {
                      if (!bestSol || 0 < bestSol.z) {
                          bestSol = { pos: posFloor, orientation: 'horizontal-x', z: 0 };
                      }
                  }

                  // Stack
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

      if (bestSol) {
          return { pos: bestSol.pos, orientation: bestSol.orientation };
      }
      return null;
  }

  // --- NEW STRATEGIES ---

  private packHorizontalDominant(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort((a,b) => {
          const volA = a.diameter * a.diameter * a.length;
          const volB = b.diameter * b.diameter * b.length;
          return volB - volA;
      });
      return this.packGreedyStrictOrder(sorted, 'horizontal-first');
  }

  private packSmartGrid(allCylinders: Cylinder[], mode: 'diameter-desc' | 'length-desc'): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
        allCylinders.forEach(c => c.placed = false);
        const placed: PlacedCylinder[] = [];
        const placedBoxes: PlacedBox[] = [];

        let currentY = 0;

        if (mode === 'length-desc') {
             const lengthGroups = new Map<number, Cylinder[]>();
             for(const c of allCylinders) {
                 const l = Math.floor(c.length);
                 if(!lengthGroups.has(l)) lengthGroups.set(l, []);
                 lengthGroups.get(l)!.push(c);
             }
             const sortedLengths = Array.from(lengthGroups.keys()).sort((a,b) => b - a);

             for(const l of sortedLengths) {
                 const lItems = lengthGroups.get(l)!;
                 const dGroups = new Map<number, Cylinder[]>();
                 for(const c of lItems) {
                     if(!dGroups.has(c.diameter)) dGroups.set(c.diameter, []);
                     dGroups.get(c.diameter)!.push(c);
                 }
                 const sortedDiams = Array.from(dGroups.keys()).sort((a,b) => b - a);

                 for(const d of sortedDiams) {
                     const group = dGroups.get(d)!;
                     this.packRowGroup(group, d, placed, placedBoxes, currentY);
                 }

                 let maxY = currentY;
                 for(const b of placedBoxes) if(b.yMax > maxY) maxY = b.yMax;
                 currentY = maxY;
             }
        } else {
             const dGroups = new Map<number, Cylinder[]>();
             for(const c of allCylinders) {
                 if(!dGroups.has(c.diameter)) dGroups.set(c.diameter, []);
                 dGroups.get(c.diameter)!.push(c);
             }
             const sortedDiams = Array.from(dGroups.keys()).sort((a,b) => b - a);

             for(const d of sortedDiams) {
                 const group = dGroups.get(d)!;
                 group.sort((a,b) => b.length - a.length);
                 this.packRowGroup(group, d, placed, placedBoxes, currentY);

                 let maxY = currentY;
                 for(const b of placedBoxes) if(b.yMax > maxY) maxY = b.yMax;
                 currentY = maxY;
             }
        }

        this.runAggressivePass(allCylinders, placedBoxes, placed);
        return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  private packRowGroup(group: Cylinder[], d: number, placed: PlacedCylinder[], placedBoxes: PlacedBox[], startY: number) {
      let rowX = 0;
      let rowY = startY;

      for(const cyl of group) {
           if(cyl.placed) continue;
           if(cyl.length > this.H) continue;

           if (rowX + d > this.W) {
               rowX = 0;
               rowY += d;
           }

           if (rowY + d > this.L) break;

           const pos = { x: rowX, y: rowY, z: 0 };
           if (this.canPlaceVertical(pos, d, cyl.length, placedBoxes)) {
                const p = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(p);
                placedBoxes.push(this.createBoxFromPlaced(p));
                cyl.placed = true;

                rowX += d;
           }
      }
  }

  private packByPerfectColumns(
      allCylinders: Cylinder[],
      mode: 'vertical' | 'horizontal' = 'vertical'
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
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
         let rowY = currentY;
         let rowMaxYStep = 0;

         const colZ = new Array(cols).fill(0);
         const colX = Array.from({length: cols}, (_, i) => i * diameter);

         let cylIdx = 0;
         while(cylIdx < cylinders.length) {
             const cyl = cylinders[cylIdx];
             if (cyl.placed) {
                 cylIdx++;
                 continue;
             }

             let placedInRow = false;

             for(let cIdx = 0; cIdx < cols; cIdx++) {
                 const x = colX[cIdx];
                 const z = colZ[cIdx];

                 let itemH = 0;
                 let itemYDim = 0;

                 if (mode === 'vertical') {
                     itemH = cyl.length;
                     itemYDim = diameter;
                 } else {
                     itemH = diameter;
                     itemYDim = cyl.length;
                 }

                 if (z + itemH > this.H) continue;
                 if (x + diameter > this.W) continue;
                 if (rowY + itemYDim > this.L) break;

                 const pos = { x, y: rowY, z };
                 let success = false;
                 let p: PlacedCylinder;

                 if (mode === 'vertical') {
                     if (this.canPlaceVertical(pos, diameter, cyl.length, placedBoxes)) {
                         p = this.createVerticalPlacedCylinder(cyl, pos);
                         success = true;
                     }
                 } else {
                     if (this.canPlace(pos, diameter, cyl.length, placedBoxes)) {
                         p = this.createPlacedCylinder(cyl, pos);
                         success = true;
                     }
                 }

                 if (success) {
                     placed.push(p!);
                     placedBoxes.push(this.createBoxFromPlaced(p!));
                     cyl.placed = true;
                     colZ[cIdx] += itemH;
                     rowMaxYStep = Math.max(rowMaxYStep, itemYDim);
                     placedInRow = true;
                     break;
                 }
             }

             if (placedInRow) {
                 cylIdx++;
             } else {
                 if (rowMaxYStep === 0) {
                     cylIdx++;
                     continue;
                 }

                 rowY += rowMaxYStep;
                 if (rowY >= this.L) break;

                 rowMaxYStep = 0;
                 colZ.fill(0);

             }
         }
         currentY = rowY + rowMaxYStep;
     }

     this.runAggressivePass(allCylinders, placedBoxes, placed);
     return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
  }

  // --- RANDOMIZED STRATEGY ---
  private packRandomized(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      let bestLocalResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } = { placed: [], unplaced: [] };
      let bestCount = -1;

      const workingSet = [...allCylinders];
      const startTime = Date.now();
      const TIME_LIMIT_MS = 15000;

      for(let i=0; i<50; i++) { // Reduced iterations as greedy is now smarter/different
          if (Date.now() - startTime > TIME_LIMIT_MS) break;

          let currentResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] };

          if (i < 10) {
             this.shuffle(workingSet);
             workingSet.forEach(c => c.placed = false);
             currentResult = this.packGreedyStrictOrder(workingSet);
          } else {
             // Smart Shuffle
             workingSet.sort((a,b) => (b.diameter**2 * b.length) - (a.diameter**2 * a.length));
             const keepCount = Math.floor(workingSet.length * 0.4);
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
                   placed: [...currentResult.placed],
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

  private shuffle(array: any[]) {
      for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
      }
  }

  // --- FACTORY METHODS ---
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

      // Sort by Volume Descending (Largest First)
      unplaced.sort((a,b) => {
          const volA = a.diameter * a.diameter * a.length;
          const volB = b.diameter * b.diameter * b.length;
          return volB - volA;
      });

      for (const cyl of unplaced) {
        const result = this.tryAggressivePlacement(cyl, placedBoxes);
        if (result) {
             const EPS = 0.001;
             let fits = true;

             // Double check bounds (Redundant but safe)
             const box: any = {};
             if (result.orientation === 'horizontal-x') {
                 box.xMax = result.pos.x + cyl.length; box.yMax = result.pos.y + cyl.diameter; box.zMax = result.pos.z + cyl.diameter;
             } else if (result.orientation === 'vertical') {
                 box.xMax = result.pos.x + cyl.diameter; box.yMax = result.pos.y + cyl.diameter; box.zMax = result.pos.z + cyl.length;
             } else {
                 box.xMax = result.pos.x + cyl.diameter; box.yMax = result.pos.y + cyl.length; box.zMax = result.pos.z + cyl.diameter;
             }

             // STRICT BOUNDARY CHECK: No EPS on Max
             if (result.pos.x < -EPS || box.xMax > this.W) fits = false;
             if (result.pos.y < -EPS || box.yMax > this.L) fits = false;
             if (result.pos.z < -EPS || box.zMax > this.H) fits = false;

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
      const sorted = [...allCylinders].sort((a,b) => {
          const volA = a.diameter * a.diameter * a.length;
          const volB = b.diameter * b.diameter * b.length;
          return volB - volA;
      });
      return this.packGreedyStrictOrder(sorted);
  }

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

     return this.packGreedyStrictOrder(canBeVertical);
  }

  private packMixedOrientations(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort((a,b) => (b.diameter*b.diameter*b.length) - (a.diameter*a.diameter*a.length));
      return this.packGreedyStrictOrder(sorted);
  }

  private packByPerfectColumns(
      allCylinders: Cylinder[],
      mode: 'vertical' | 'horizontal' = 'vertical'
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
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
         let rowY = currentY;
         let rowMaxYStep = 0;

         const colZ = new Array(cols).fill(0);
         const colX = Array.from({length: cols}, (_, i) => i * diameter);

         let cylIdx = 0;
         while(cylIdx < cylinders.length) {
             const cyl = cylinders[cylIdx];
             if (cyl.placed) {
                 cylIdx++;
                 continue;
             }

             let placedInRow = false;

             for(let cIdx = 0; cIdx < cols; cIdx++) {
                 const x = colX[cIdx];
                 const z = colZ[cIdx];

                 let itemH = 0;
                 let itemYDim = 0;

                 if (mode === 'vertical') {
                     itemH = cyl.length;
                     itemYDim = diameter;
                 } else {
                     itemH = diameter;
                     itemYDim = cyl.length;
                 }

                 if (z + itemH > this.H) continue;
                 if (x + diameter > this.W) continue;
                 if (rowY + itemYDim > this.L) break;

                 const pos = { x, y: rowY, z };
                 let success = false;
                 let p: PlacedCylinder;

                 if (mode === 'vertical') {
                     if (this.canPlaceVertical(pos, diameter, cyl.length, placedBoxes)) {
                         p = this.createVerticalPlacedCylinder(cyl, pos);
                         success = true;
                     }
                 } else {
                     if (this.canPlace(pos, diameter, cyl.length, placedBoxes)) {
                         p = this.createPlacedCylinder(cyl, pos);
                         success = true;
                     }
                 }

                 if (success) {
                     placed.push(p!);
                     placedBoxes.push(this.createBoxFromPlaced(p!));
                     cyl.placed = true;
                     colZ[cIdx] += itemH;
                     rowMaxYStep = Math.max(rowMaxYStep, itemYDim);
                     placedInRow = true;
                     break;
                 }
             }

             if (placedInRow) {
                 cylIdx++;
             } else {
                 if (rowMaxYStep === 0) {
                     cylIdx++;
                     continue;
                 }

                 rowY += rowMaxYStep;
                 if (rowY >= this.L) break;

                 rowMaxYStep = 0;
                 colZ.fill(0);

             }
         }
         currentY = rowY + rowMaxYStep;
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

  // --- PRIMITIVES ---

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
      const EPS = 0.0001;

      for (const box of placedBoxes) {
          const myXMax = (orientation === 'horizontal-y') ? x + diameter : x + length;
          const myYMax = (orientation === 'horizontal-y') ? y + length : y + diameter;

          if (x >= box.xMax - EPS || myXMax <= box.xMin + EPS) continue;
          if (y >= box.yMax - EPS || myYMax <= box.yMin + EPS) continue;

          if (box.orientation === 'vertical') {
              if (box.zMax > maxZ) maxZ = box.zMax;
          }
          else {
              const boxIsRotated = box.orientation === 'horizontal-x';
              const boxR = (boxIsRotated ? (box.yMax - box.yMin) : (box.xMax - box.xMin)) / 2;
              const boxCx = box.xMin + (boxIsRotated ? (box.xMax - box.xMin)/2 : boxR);
              const boxCz = box.zMin + boxR;

              if (orientation !== box.orientation) {
                  if (box.zMax > maxZ) maxZ = box.zMax;
              } else {
                  let distPerp = 0;
                  if (orientation === 'horizontal-y') {
                      distPerp = Math.abs(cx - boxCx);
                  } else {
                      const boxCy = box.yMin + boxR;
                      distPerp = Math.abs(cy - boxCy);
                  }

                  const sumRadii = radius + boxR;
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

    // Strict boundary checks
    if (x < -EPS || x + diameter > this.W) return false;
    if (y < -EPS || y + diameter > this.L) return false;
    if (z < -EPS || z + length > this.H) return false;

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
        const minDist = radius + otherR - EPS;

        if (distSq < minDist * minDist) return false;
      } else {
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

    if (x < -EPS || x + diameter > this.W) return false;
    if (y < -EPS || y + length > this.L) return false;
    if (z < -EPS || z + diameter > this.H) return false;

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
         const minDist = radius + otherR - EPS;
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

    if (x < -EPS || x + length > this.W) return false;
    if (y < -EPS || y + diameter > this.L) return false;
    if (z < -EPS || z + diameter > this.H) return false;

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
         const minDist = radius + otherR - EPS;
         if (distSq < minDist**2) return false;
      }
    }
    return true;
  }

  private tryAggressivePlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
      // Default: Vertical First
      const v = this.findVerticalCandidate(cyl, placedBoxes);
      if (v) return v;
      return this.findHorizontalCandidate(cyl, placedBoxes);
  }

  // --- PRIMITIVE FINDERS ---

  private findVerticalCandidate(
      cyl: Cylinder,
      placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'vertical' } | null {
      const { diameter, length } = cyl;
      if (length > this.H) return null;

      // Candidate Points
      const xCandidates = new Set<number>(); xCandidates.add(0);
      const yCandidates = new Set<number>(); yCandidates.add(0);
      const zCandidates = new Set<number>(); zCandidates.add(0);

      for(const b of placedBoxes) {
          if (b.xMax <= this.W) xCandidates.add(b.xMax);
          if (b.yMax <= this.L) yCandidates.add(b.yMax);
          if (b.zMax + length <= this.H) zCandidates.add(b.zMax);
      }

      const sortedX = Array.from(xCandidates).sort((a,b) => a-b);
      const sortedY = Array.from(yCandidates).sort((a,b) => a-b);
      const sortedZ = Array.from(zCandidates).sort((a,b) => a-b);

      for(const z of sortedZ) {
         for (const y of sortedY) {
             if (y + diameter > this.L) break;
             for(const x of sortedX) {
                 if (x + diameter > this.W) break;

                 const pos = { x, y, z };
                 if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                      return { pos, orientation: 'vertical' };
                 }
             }
         }
      }
      return null;
  }

  private findHorizontalCandidate(
      cyl: Cylinder,
      placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' } | null {
      const { diameter, length } = cyl;

      const xCandidates = new Set<number>(); xCandidates.add(0);
      const yCandidates = new Set<number>(); yCandidates.add(0);
      for(const b of placedBoxes) {
          if (b.xMax <= this.W) xCandidates.add(b.xMax);
          if (b.yMax <= this.L) yCandidates.add(b.yMax);
      }
      const sortedX = Array.from(xCandidates).sort((a,b) => a-b);
      const sortedY = Array.from(yCandidates).sort((a,b) => a-b);

      let bestSol: { pos: { x: number, y: number, z: number }, orientation: 'horizontal-y' | 'horizontal-x', z: number } | null = null;

      // 1. Horizontal-Y
      for (const y of sortedY) {
          if (y + length > this.L) break;
          for (const x of sortedX) {
              if (x + diameter > this.W) break;

              // Floor First (Optimization)
              const posFloor = { x, y, z: 0 };
              if (this.canPlace(posFloor, diameter, length, placedBoxes)) {
                  if (!bestSol || 0 < bestSol.z) {
                      bestSol = { pos: posFloor, orientation: 'horizontal-y', z: 0 };
                      // Floor found, but we must check Horizontal-X too?
                      // Usually Y is better aligned.
                  }
              }

              // Stack
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

      // 2. Horizontal-X
      if (length <= this.W) {
          for (const y of sortedY) {
              if (y + diameter > this.L) break;
              for (const x of sortedX) {
                  if (x + length > this.W) break;

                  // Floor
                  const posFloor = { x, y, z: 0 };
                  if (this.canPlaceRotated(posFloor, diameter, length, placedBoxes)) {
                      if (!bestSol || 0 < bestSol.z) {
                          bestSol = { pos: posFloor, orientation: 'horizontal-x', z: 0 };
                      }
                  }

                  // Stack
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

      if (bestSol) {
          return { pos: bestSol.pos, orientation: bestSol.orientation };
      }
      return null;
  }
}
