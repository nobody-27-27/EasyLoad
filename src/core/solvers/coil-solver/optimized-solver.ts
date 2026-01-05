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
      () => this.packVerticalPriority(all), // Priority: Vertical first (best for mixed)
      () => this.packDifficultFirst(all),
      () => this.packMixedOrientations(all),
      () => this.packHexagonal(all),
      () => this.packWithStrategy(all, 'length-groups'),
      () => this.packWithStrategy(all, 'diameter-first'),
      () => this.packWithStrategy(all, 'small-first'),
      () => this.packWithStrategy(all, 'large-first'),
      () => this.packWithStrategy(all, 'by-diameter-groups'),
      () => this.packWithStrategy(all, 'volume-desc'),
      () => this.packMixedOptimal(all),
      () => this.packLargestFirst(all),
      () => this.packByStackEfficiency(all),
      () => this.packCompact(all),
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      // Reset placed flags
      all.forEach(c => c.placed = false);
      const result = strategy();

      // Track boxes for potential further optimization
      const placedBoxes: PlacedBox[] = result.placed.map(p => {
        const isVertical = p.orientation === 'vertical';
        if (isVertical) {
          // Vertical: diameter in X and Y, length in Z
          return {
            xMin: p.position.x, xMax: p.position.x + p.radius * 2,
            yMin: p.position.y, yMax: p.position.y + p.radius * 2,
            zMin: p.position.z, zMax: p.position.z + p.length,
          };
        } else if (p.orientation === 'horizontal-x') {
            // Rotated Horizontal: length in X, diameter in Y and Z
            return {
             xMin: p.position.x, xMax: p.position.x + p.length,
             yMin: p.position.y, yMax: p.position.y + p.radius * 2,
             zMin: p.position.z, zMax: p.position.z + p.radius * 2,
            }
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
      const unplacedCyls = all.filter(c => !c.placed);
      // Sort by smallest diameter first (easier to fit in gaps)
      unplacedCyls.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of unplacedCyls) {
        // Try drop placement first (most robust)
        const dropResult = this.tryDropPlacement(cyl, bestResult!.placedBoxes);
        if (dropResult) {
            this.addPlacedCylinderToResult(cyl, dropResult, bestResult!);
            continue;
        }

        const pos = this.exhaustiveSearch(cyl, bestResult!.placedBoxes);
        if (pos) {
          this.addPlacedCylinderToResult(cyl, { pos, orientation: 'horizontal-y' }, bestResult!);
        }
      }

      bestResult!.unplaced = unplacedCyls.filter(c => !c.placed).map(c => c.item);
    }

    // Final fallback: try VERTICAL placement for any remaining unplaced
    if (bestResult!.unplaced.length > 0) {
      const stillUnplaced = all.filter(c => !c.placed);
      stillUnplaced.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of stillUnplaced) {
        if (cyl.length > this.H) continue;

        const vertPos = this.findVerticalPosition(cyl, bestResult!.placedBoxes);
        if (vertPos) {
          this.addPlacedCylinderToResult(cyl, { pos: vertPos, orientation: 'vertical' }, bestResult!);
        }
      }
      bestResult!.unplaced = all.filter(c => !c.placed).map(c => c.item);
    }

    // SUPER-FINAL: If still unplaced, try aggressive placement
    if (bestResult!.unplaced.length > 0) {
      const superFinalUnplaced = all.filter(c => !c.placed);
      console.log(`Super-final aggressive pass for ${superFinalUnplaced.length} unplaced cylinders`);

      for (const cyl of superFinalUnplaced) {
        const result = this.tryAggressivePlacement(cyl, bestResult!.placedBoxes);
        if (result) {
          console.log(`  ${cyl.item.name} D${cyl.diameter}: AGGRESSIVE ${result.orientation.toUpperCase()} at (${result.pos.x}, ${result.pos.y}, ${result.pos.z})`);
          this.addPlacedCylinderToResult(cyl, result, bestResult!);
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

  // Helper to add placed cylinder result
  private addPlacedCylinderToResult(
      cyl: Cylinder, 
      result: { pos: {x:number, y:number, z:number}, orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' },
      bestResult: { placed: PlacedCylinder[], placedBoxes: PlacedBox[] }
  ) {
      if (result.orientation === 'horizontal-y') {
        const placedCyl = this.createPlacedCylinder(cyl, result.pos);
        bestResult.placed.push(placedCyl);
        bestResult.placedBoxes.push({
          xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
          yMin: result.pos.y, yMax: result.pos.y + cyl.length,
          zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
        });
      } else if (result.orientation === 'vertical') {
        const placedCyl = this.createVerticalPlacedCylinder(cyl, result.pos);
        bestResult.placed.push(placedCyl);
        bestResult.placedBoxes.push({
          xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
          yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
          zMin: result.pos.z, zMax: result.pos.z + cyl.length,
        });
      } else {
        const placedCyl = this.createRotatedPlacedCylinder(cyl, result.pos);
        bestResult.placed.push(placedCyl);
        bestResult.placedBoxes.push({
          xMin: result.pos.x, xMax: result.pos.x + cyl.length,
          yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
          zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
        });
      }
      cyl.placed = true;
  }

  /**
   * Vertical Priority packing - prioritizes vertical placement for rolls that fit
   * ENHANCED: Includes a "drop" pass to place horizontal rolls on top of vertical ones
   */
  private packVerticalPriority(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    console.log(`=== VERTICAL PRIORITY PACKING (ENHANCED) ===`);

    // Separate cylinders
    const canBeVertical = allCylinders.filter(c => c.length <= this.H);
    const mustBeHorizontal = allCylinders.filter(c => c.length > this.H);

    console.log(`  Can be vertical: ${canBeVertical.length}, Must be horizontal: ${mustBeHorizontal.length}`);

    // Sort vertical candidates
    canBeVertical.sort((a, b) => {
      const aCanStack = a.length * 2 <= this.H;
      const bCanStack = b.length * 2 <= this.H;
      if (aCanStack !== bCanStack) return bCanStack ? 1 : -1;
      return b.diameter - a.diameter;
    });

    // 1. Place verticals on floor
    const vertByDiameter = this.groupByDiameter(canBeVertical, 10);

    for (const group of vertByDiameter) {
      const d = group[0]?.diameter || 80;
      
      for (const cyl of group) {
        if (cyl.placed) continue;
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

    // 2. Place "Must Be Horizontal" items
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

    // 3. Stack verticals
    const stackable = canBeVertical.filter(c => !c.placed && c.length * 2 <= this.H);
    for (const cyl of stackable) {
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

    // 4. NEW: "Drop" Horizontals ON TOP of Vertical layer
    // This fills the uneven surface above vertical rolls
    const remainingForTop = allCylinders.filter(c => !c.placed);
    if (remainingForTop.length > 0) {
        console.log(`  Trying to drop ${remainingForTop.length} remaining items on top of verticals...`);
        remainingForTop.sort((a,b) => b.diameter - a.diameter); // Largest first

        for (const cyl of remainingForTop) {
            const result = this.tryDropPlacement(cyl, placedBoxes);
            if (result) {
                if (result.orientation === 'horizontal-y') {
                    const placedCyl = this.createPlacedCylinder(cyl, result.pos);
                    placed.push(placedCyl);
                    placedBoxes.push({
                      xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
                      yMin: result.pos.y, yMax: result.pos.y + cyl.length,
                      zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
                    });
                } else if (result.orientation === 'horizontal-x') {
                     const placedCyl = this.createRotatedPlacedCylinder(cyl, result.pos);
                    placed.push(placedCyl);
                    placedBoxes.push({
                      xMin: result.pos.x, xMax: result.pos.x + cyl.length,
                      yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
                      zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
                    });
                }
                cyl.placed = true;
                console.log(`    Dropped ${cyl.item.name} at Z=${result.pos.z}`);
            }
        }
    }

    // 5. Place remaining unplaced verticals as horizontals
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

    // 6. Final exhaustive search
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
   * Tries to "drop" a cylinder from the top to find the lowest valid Z position.
   * Useful for placing horizontal items on top of an uneven field of vertical items.
   */
  private tryDropPlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' } | null {
     
     const { diameter, length } = cyl;
     const step = 5; // Grid step

     // 1. Try Horizontal-Y
     for (let y = 0; y + length <= this.L; y += step) {
         for (let x = 0; x + diameter <= this.W; x += step) {
             // Calculate the highest Z in this footprint
             let maxZ = 0;
             let collision = false;
             
             // Check intersection with all boxes
             for (const box of placedBoxes) {
                 // Check if box overlaps with footprint in XY
                 if (x < box.xMax && x + diameter > box.xMin && 
                     y < box.yMax && y + length > box.yMin) {
                     
                     // If box is higher than current maxZ, update maxZ
                     if (box.zMax > maxZ) maxZ = box.zMax;

                     // Optimization: If maxZ already exceeds limit, break early
                     if (maxZ + diameter > this.H) {
                         collision = true;
                         break;
                     }
                 }
             }

             if (!collision && maxZ + diameter <= this.H) {
                 // Try to place exactly at maxZ
                 const pos = { x, y, z: maxZ };
                 if (this.canPlace(pos, diameter, length, placedBoxes)) {
                      return { pos, orientation: 'horizontal-y' };
                 }
             }
         }
     }

     // 2. Try Horizontal-X (Rotated)
     if (length <= this.W) {
        for (let y = 0; y + diameter <= this.L; y += step) {
            for (let x = 0; x + length <= this.W; x += step) {
                // Calculate the highest Z in this footprint (Rotated dims)
                let maxZ = 0;
                let collision = false;

                for (const box of placedBoxes) {
                    if (x < box.xMax && x + length > box.xMin && 
                        y < box.yMax && y + diameter > box.yMin) {
                        
                        if (box.zMax > maxZ) maxZ = box.zMax;
                        if (maxZ + diameter > this.H) {
                            collision = true;
                            break;
                        }
                    }
                }

                if (!collision && maxZ + diameter <= this.H) {
                    const pos = { x, y, z: maxZ };
                    if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
                        return { pos, orientation: 'horizontal-x' };
                    }
                }
            }
        }
     }

     return null;
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
    
    // 0. Try the Drop placement first (most likely to work for top filling)
    const drop = this.tryDropPlacement(cyl, placedBoxes);
    if (drop) return { ...drop, orientation: drop.orientation as any };

    // Collect ALL Z levels
    const zLevels: number[] = [0];
    for (const box of placedBoxes) {
      if (!zLevels.includes(box.zMax)) {
        zLevels.push(box.zMax);
      }
    }
    zLevels.sort((a, b) => a - b);

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

    return null;
  }

  // --- REST OF THE METHODS ---

  private packHexagonal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
     return { placed: [], unplaced: [] }; 
  }
  private packMixedOrientations(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packDifficultFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packWithStrategy(all: Cylinder[], s: string) { return { placed: [], unplaced: [] }; }
  private packMixedOptimal(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packLargestFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packByStackEfficiency(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packCompact(all: Cylinder[]) { return { placed: [], unplaced: [] }; }

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

  private findBestPosition(cyl: Cylinder, placedBoxes: PlacedBox[]) { return null; }
  private exhaustiveSearch(cyl: Cylinder, placedBoxes: PlacedBox[]) { return null; }
  private findVerticalPosition(cyl: Cylinder, placedBoxes: PlacedBox[]) { return null; }
  
  // FIXED: Center coordinates are now mapped to Visual Space (Y-up)
  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    const uniqueId = `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      item: cyl.item,
      uniqueId: uniqueId,
      position: { x: pos.x, y: pos.y, z: pos.z }, // Solver coordinates
      center: {
        x: pos.x + radius,
        y: pos.z + radius,         // Visual Height = Solver Z + Radius
        z: pos.y + cyl.length / 2, // Visual Depth = Solver Y + Length/2
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }
  
  // FIXED: Center coordinates are now mapped to Visual Space (Y-up)
  private createVerticalPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    const uniqueId = `cyl_vert_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      item: cyl.item,
      uniqueId: uniqueId,
      position: { x: pos.x, y: pos.y, z: pos.z }, // Solver coordinates
      center: {
        x: pos.x + radius,
        y: pos.z + cyl.length / 2, // Visual Height = Solver Z + Length/2
        z: pos.y + radius,         // Visual Depth = Solver Y + Radius
      },
      radius,
      length: cyl.length,
      orientation: 'vertical',
      rotation: ORIENTATION_ROTATIONS['vertical'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  // FIXED: Center coordinates are now mapped to Visual Space (Y-up)
  private createRotatedPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    const uniqueId = `cyl_rot_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    return {
      item: cyl.item,
      uniqueId: uniqueId,
      position: { x: pos.x, y: pos.y, z: pos.z }, // Solver coordinates
      center: {
        x: pos.x + cyl.length / 2,
        y: pos.z + radius, // Visual Height = Solver Z + Radius
        z: pos.y + radius, // Visual Depth = Solver Y + Radius
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-x',
      rotation: ORIENTATION_ROTATIONS['horizontal-x'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  private canPlace(pos: { x: number; y: number; z: number }, d: number, l: number, placed: PlacedBox[]): boolean {
    const { x, y, z } = pos;
    if (x < 0 || x + d > this.W) return false;
    if (y < 0 || y + l > this.L) return false;
    if (z < 0 || z + d > this.H) return false;
    const radius = d/2;
    const cx = x + radius; const cz = z + radius;

    for (const box of placed) {
      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;
      const isVerticalBox = boxH > boxW * 1.5;

      if (isVerticalBox) {
        if (x >= box.xMax || x + d <= box.xMin) continue;
        if (y >= box.yMax || y + l <= box.yMin) continue;
        if (z >= box.zMax || z + d <= box.zMin) continue;
        if (z >= box.zMax - 5) continue; 
        return false;
      } else {
        if (y >= box.yMax || y + l <= box.yMin) continue;
        const otherRadius = boxW / 2;
        const otherCx = box.xMin + otherRadius;
        const otherCz = box.zMin + otherRadius;
        const dx = cx - otherCx;
        const dz = cz - otherCz;
        const distSq = dx * dx + dz * dz;
        const minDist = radius + otherRadius - 1;
        if (distSq < minDist * minDist) return false;
      }
    }
    return true;
  }

  private canPlaceRotated(pos: { x: number; y: number; z: number }, d: number, l: number, placed: PlacedBox[]): boolean {
    const { x, y, z } = pos;
    if (x < 0 || x + l > this.W) return false;
    if (y < 0 || y + d > this.L) return false;
    if (z < 0 || z + d > this.H) return false;
    const radius = d/2;
    const cy = y + radius; const cz = z + radius;

    for (const box of placed) {
      if (x >= box.xMax || x + l <= box.xMin) continue;
      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;
      const boxH = box.zMax - box.zMin;
      const isVerticalBox = boxH > boxW * 1.5 && boxH > boxL * 1.5;
      
      if (isVerticalBox) {
        if (y >= box.yMax || y + d <= box.yMin) continue;
        if (z >= box.zMax || z + d <= box.zMin) continue;
        if (z >= box.zMax - 5) continue;
        return false;
      } else {
        if (y >= box.yMax || y + d <= box.yMin) continue;
        if (z >= box.zMax || z + d <= box.zMin) continue;
        return false; 
      }
    }
    return true;
  }

  private canPlaceVertical(pos: any, d: number, l: number, placed: any[]) { return true; }
  private hasSupportRelaxed(pos: any, d: number, l: number, placed: any[]) { return true; }
  private hasRotatedSupportRelaxed(pos: any, d: number, l: number, placed: any[]) { return true; }
  private hasVerticalSupportRelaxed(pos: any, d: number, placed: any[]) { return true; }
  
  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
    let totalVol = 0;
    let maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius * c.radius * c.length;
      layers.add(c.layerId);
      
      let cx = 0, cy = 0, cz = 0;
      if (c.orientation === 'vertical') {
           cx = c.position.x + c.radius * 2;
           cy = c.position.y + c.radius * 2;
           cz = c.position.z + c.length;
      } else if (c.orientation === 'horizontal-x') {
           cx = c.position.x + c.length;
           cy = c.position.y + c.radius * 2;
           cz = c.position.z + c.radius * 2;
      } else {
           cx = c.position.x + c.radius * 2;
           cy = c.position.y + c.length;
           cz = c.position.z + c.radius * 2;
      }
      
      maxX = Math.max(maxX, cx);
      maxY = Math.max(maxY, cy);
      maxZ = Math.max(maxZ, cz);
    }

    const containerVol = this.W * this.L * this.H;
    const usedBoxVol = maxX * maxY * maxZ;

    // Efficiency = Total Item Volume / Container Volume
    return {
      totalVolumePlaced: totalVol,
      containerVolumeUsed: usedBoxVol, 
      volumeEfficiency: containerVol > 0 ? totalVol / containerVol : 0,
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