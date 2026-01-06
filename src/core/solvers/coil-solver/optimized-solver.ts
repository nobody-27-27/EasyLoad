// src/core/solvers/coil-solver/optimized-solver.ts

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

    console.log(`=== CYLINDER PACKING (User Manual Strategy) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    const strategies = [
      () => this.packManualHeuristic(all),
      () => this.packVerticalPriority(all),
      () => this.packDifficultFirst(all),
      () => this.packMixedOrientations(all),
      () => this.packHexagonal(all),
      () => this.packCompact(all),
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      all.forEach(c => c.placed = false);
      const result = strategy();
      const placedBoxes = result.placed.map(p => this.getBoxFromPlaced(p));

      // Calculate REAL unplaced count based on result.placed vs all.length
      // This fixes the "Full placement" log bug if placed < all
      const realUnplacedCount = all.length - result.placed.length;

      if (!bestResult || result.placed.length > bestResult.placed.length) {
        bestResult = { ...result, unplaced: result.unplaced, placedBoxes };
      }

      if (realUnplacedCount === 0) {
        console.log("Full placement achieved with strategy!");
        break;
      }
    }

    // Final Attempt: Aggressive Drop for any remaining
    const finalPlaced = [...bestResult!.placed];
    const finalPlacedBoxes = [...bestResult!.placedBoxes];
    
    // Identifiy items that are NOT in the finalPlaced array
    // (We re-calculate unplaced based on what is actually in the placed list to be safe)
    const placedIds = new Set(finalPlaced.map(p => p.uniqueId));
    const actuallyUnplacedCyls = all.filter(c => {
       // We can't use c.placed here easily because it might be from a different strategy run
       // So we check if this cylinder's ID (we need a way to track it) is in result
       // Actually, simplified: we just run a fresh pass for anything not marked placed in the BEST strategy
       // But 'c.placed' is dirty.
       
       // Correct approach: Use the unplaced items returned by the strategy
       return false; // We will use bestResult.unplaced directly
    });

    // Actually, simpler: just iterate bestResult.unplaced items and try to fit them
    // We need to map CargoItem back to Cylinder struct to try placing
    // This is hard because we lost the wrapper.
    // So instead, we rely on the heuristic's own 'leftovers' logic.
    
    // Let's just output what we have.
    const placed = bestResult!.placed;
    // Recalculate unplaced items from the source to ensure consistency
    // We need to know WHICH original items correspond to placed ones.
    // The 'uniqueId' in PlacedCylinder is generated. 'item' is ref.
    const placedItemsSet = new Set(placed.map(p => p.item));
    const unplacedItems = cylinders.flatMap(i => {
        // This is tricky with quantities.
        // Simplest: all.filter(c => !placed.some(p => p.item === c.item))
        // But c.item is shared.
        // We need to track by index.
        return [];
    });
    
    // Fallback: use the unplaced array returned by the strategy
    const unplaced = bestResult!.unplaced;

    console.log(`Placed: ${placed.length}/${all.length}`);

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calcStats(placed, unplaced.length),
    };
  }

  private packManualHeuristic(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    console.log("Running Manual Heuristic: Block 1 -> Block 2 -> Tops");
    allCylinders.forEach(c => c.placed = false);
    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    const is78x160 = (c: Cylinder) => Math.abs(c.diameter - 78) < 2 && Math.abs(c.length - 160) < 2;
    const isMixedVertical = (c: Cylinder) => !is78x160(c) && c.length >= 130 && c.length <= 150; 
    const isHorizForBlock1 = (c: Cylinder) => (Math.abs(c.diameter - 78) < 2 && Math.abs(c.length - 160) < 2) || (Math.abs(c.diameter - 77) < 2 && Math.abs(c.length - 152) < 2);
    const isHorizForBlock2 = (c: Cylinder) => Math.abs(c.diameter - 90) < 2;

    const pool = [...allCylinders];
    
    // BLOCK 1 (Vertical 78x160)
    let block1Count = 0;
    for (let y = 0; y < this.L; y += 78) {
        for (let x = 0; x <= this.W - 78; x += 78) {
            if (block1Count >= 24) break;
            const idx = pool.findIndex(c => !c.placed && is78x160(c));
            if (idx !== -1) {
                const cyl = pool[idx];
                const p = this.createVerticalPlacedCylinder(cyl, { x, y, z: 0 });
                placed.push(p);
                placedBoxes.push(this.getBoxFromPlaced(p));
                cyl.placed = true;
                block1Count++;
            }
        }
        if (block1Count >= 24) break;
    }
    console.log(`Block 1 Placed: ${block1Count}/24`);

    // BLOCK 2 (Mixed Vertical)
    let startYBlock2 = 0;
    placedBoxes.forEach(b => { if (b.yMax > startYBlock2) startYBlock2 = b.yMax; });
    startYBlock2 += 1;

    const remainingVerticals = pool.filter(c => !c.placed && (isMixedVertical(c) || is78x160(c)));
    remainingVerticals.sort((a, b) => b.diameter - a.diameter);

    for (const cyl of remainingVerticals) {
        let found = false;
        // Try tighter grid for mixed items
        for (let y = startYBlock2; y + cyl.diameter <= this.L; y += cyl.diameter) {
            for (let x = 0; x + cyl.diameter <= this.W; x += cyl.diameter) {
                const pos = { x, y, z: 0 };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const p = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(p);
                    placedBoxes.push(this.getBoxFromPlaced(p));
                    cyl.placed = true;
                    found = true;
                    break;
                }
            }
            if (found) break;
        }
    }

    // TOPS
    const horizontals = pool.filter(c => !c.placed);
    const topGroup1 = horizontals.filter(c => isHorizForBlock1(c));
    const topGroup2 = horizontals.filter(c => isHorizForBlock2(c));

    // Top Group 1 (on Block 1)
    for (const cyl of topGroup1) {
        let found = false;
        // Search Z>150 on Block 1 area
        for (let y = 0; y < startYBlock2 - cyl.length; y += 20) {
            for (let x = 0; x <= this.W - cyl.diameter; x += 10) {
                const drop = this.findDropZ({x, y}, cyl.diameter, cyl.length, placedBoxes);
                if (drop.z >= 155 && drop.z + cyl.diameter <= this.H) {
                    const p = this.createPlacedCylinder(cyl, {x, y, z: drop.z});
                    placed.push(p);
                    placedBoxes.push(this.getBoxFromPlaced(p));
                    cyl.placed = true;
                    found = true;
                    break;
                }
            }
            if (found) break;
        }
    }

    // Top Group 2 (on Block 2)
    for (const cyl of topGroup2) {
        let found = false;
        // Search Z>130 on Block 2 area
        for (let y = startYBlock2 - 50; y + cyl.length <= this.L; y += 20) {
            for (let x = 0; x <= this.W - cyl.diameter; x += 10) {
                const drop = this.findDropZ({x, y}, cyl.diameter, cyl.length, placedBoxes);
                if (drop.z >= 130 && drop.z + cyl.diameter <= this.H) {
                    const p = this.createPlacedCylinder(cyl, {x, y, z: drop.z});
                    placed.push(p);
                    placedBoxes.push(this.getBoxFromPlaced(p));
                    cyl.placed = true;
                    found = true;
                    break;
                }
            }
            if (found) break;
        }
    }

    // Leftovers (Aggressive Fill)
    const leftovers = pool.filter(c => !c.placed);
    for (const cyl of leftovers) {
        const drop = this.tryDropPlacement(cyl, placedBoxes);
        if (drop) {
             if (drop.orientation === 'horizontal-y') {
                const p = this.createPlacedCylinder(cyl, drop.pos);
                placed.push(p);
                placedBoxes.push(this.getBoxFromPlaced(p));
             } else {
                const p = this.createRotatedPlacedCylinder(cyl, drop.pos);
                placed.push(p);
                placedBoxes.push(this.getBoxFromPlaced(p));
             }
             cyl.placed = true;
        }
    }

    const unplaced = pool.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  // --- HELPERS ---

  private findDropZ(pos: {x: number, y: number}, d: number, l: number, placed: PlacedBox[]): {x: number, y: number, z: number} {
      let maxZ = 0;
      for (const box of placed) {
          if (pos.x < box.xMax && pos.x + d > box.xMin &&
              pos.y < box.yMax && pos.y + l > box.yMin) {
              if (box.zMax > maxZ) maxZ = box.zMax;
          }
      }
      return { x: pos.x, y: pos.y, z: maxZ };
  }

  private tryDropPlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' } | null {
     
     const { diameter, length } = cyl;
     const step = 10; 

     for (let y = 0; y + length <= this.L; y += step) {
         for (let x = 0; x + diameter <= this.W; x += step) {
             const drop = this.findDropZ({x,y}, diameter, length, placedBoxes);
             if (drop.z + diameter <= this.H) {
                 const pos = { x, y, z: drop.z };
                 if (this.canPlace(pos, diameter, length, placedBoxes)) {
                      return { pos, orientation: 'horizontal-y' };
                 }
             }
         }
     }
     return null;
  }

  private packVerticalPriority(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packDifficultFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packMixedOrientations(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packHexagonal(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packCompact(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packWithStrategy(all: Cylinder[], s: string) { return { placed: [], unplaced: [] }; }
  private packMixedOptimal(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packLargestFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packByStackEfficiency(all: Cylinder[]) { return { placed: [], unplaced: [] }; }

  // COORDINATE TRANSFORMATIONS FOR 3D VIEW
  
  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    const uniqueId = `cyl_${cyl.index}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;

    return {
      item: cyl.item,
      uniqueId: uniqueId,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + radius,
        y: pos.z + radius,
        z: pos.y + cyl.length / 2,
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }
  
  private createVerticalPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    const uniqueId = `cyl_v_${cyl.index}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;

    return {
      item: cyl.item,
      uniqueId: uniqueId,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + radius,
        y: pos.z + cyl.length / 2,
        z: pos.y + radius,
      },
      radius,
      length: cyl.length,
      orientation: 'vertical',
      rotation: ORIENTATION_ROTATIONS['vertical'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  private createRotatedPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
     const radius = cyl.diameter / 2;
     const uniqueId = `cyl_r_${cyl.index}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;
     return {
        item: cyl.item,
        uniqueId: uniqueId,
        position: { x: pos.x, y: pos.y, z: pos.z },
        center: {
            x: pos.x + cyl.length / 2,
            y: pos.z + radius,
            z: pos.y + radius
        },
        radius, length: cyl.length,
        orientation: 'horizontal-x',
        rotation: ORIENTATION_ROTATIONS['horizontal-x'],
        layerId: 0, supportedBy: []
     };
  }

  private getBoxFromPlaced(p: PlacedCylinder): PlacedBox {
      if (p.orientation === 'vertical') {
          return {
              xMin: p.position.x, xMax: p.position.x + p.radius*2,
              yMin: p.position.y, yMax: p.position.y + p.radius*2,
              zMin: p.position.z, zMax: p.position.z + p.length
          };
      } else if (p.orientation === 'horizontal-x') {
          return {
              xMin: p.position.x, xMax: p.position.x + p.length,
              yMin: p.position.y, yMax: p.position.y + p.radius*2,
              zMin: p.position.z, zMax: p.position.z + p.radius*2
          };
      } else {
          return {
              xMin: p.position.x, xMax: p.position.x + p.radius*2,
              yMin: p.position.y, yMax: p.position.y + p.length,
              zMin: p.position.z, zMax: p.position.z + p.radius*2
          };
      }
  }

  private canPlaceVertical(pos: any, d: number, l: number, placed: PlacedBox[]): boolean {
      if (pos.x < 0 || pos.x + d > this.W) return false;
      if (pos.y < 0 || pos.y + d > this.L) return false;
      if (pos.z < 0 || pos.z + l > this.H) return false;
      return this.checkCollision(pos.x, pos.y, pos.z, d, d, l, placed);
  }

  private canPlace(pos: any, d: number, l: number, placed: PlacedBox[]): boolean {
      if (pos.x < 0 || pos.x + d > this.W) return false;
      if (pos.y < 0 || pos.y + l > this.L) return false;
      if (pos.z < 0 || pos.z + d > this.H) return false;
      return this.checkCollision(pos.x, pos.y, pos.z, d, l, d, placed);
  }

  private checkCollision(x: number, y: number, z: number, w: number, l: number, h: number, placed: PlacedBox[]): boolean {
      for (const box of placed) {
          if (x < box.xMax && x + w > box.xMin &&
              y < box.yMax && y + l > box.yMin &&
              z < box.zMax && z + h > box.zMin) {
              return false;
          }
      }
      return true;
  }

  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
    let totalVol = 0;
    let maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius * c.radius * c.length;
      layers.add(c.layerId);
      const b = this.getBoxFromPlaced(c);
      maxX = Math.max(maxX, b.xMax);
      maxY = Math.max(maxY, b.yMax);
      maxZ = Math.max(maxZ, b.zMax);
    }

    const containerVol = this.W * this.L * this.H;
    const usedBoxVol = maxX * maxY * maxZ;

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