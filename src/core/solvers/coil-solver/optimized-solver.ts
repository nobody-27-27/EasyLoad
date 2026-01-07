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

interface PlacedCircle {
  x: number;
  y: number;
  r: number;
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

    console.log(`=== CYLINDER PACKING (Strict Manual Strategy) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    // Tek ve Kesin Strateji
    const strategies = [
      () => this.packManualHeuristic(all),
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      all.forEach(c => c.placed = false);
      const result = strategy();
      
      if (!bestResult || result.placed.length > bestResult.placed.length) {
        const placedBoxes = result.placed.map(p => this.getBoxFromPlaced(p));
        bestResult = { ...result, placedBoxes };
      }

      if (result.placed.length === all.length) {
        console.log("Full placement achieved!");
        break;
      }
    }

    // Flagleri geri yükle
    all.forEach(c => c.placed = false);
    const placedItemSet = new Set(bestResult!.placed.map(p => p.item));
    all.forEach(c => { if (placedItemSet.has(c.item)) c.placed = true; });

    // Kalanları son kez dene (Aşırı Hassas - Step 1)
    const leftovers = all.filter(c => !c.placed);
    if (leftovers.length > 0) {
      console.log(`Attempting to place ${leftovers.length} leftovers with precision...`);
      leftovers.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of leftovers) {
        // Hem yatay hem dikey dene
        const dropResult = this.tryDropPlacement(cyl, bestResult!.placedBoxes, 1);
        if (dropResult) {
             this.addPlacedCylinderToResult(cyl, dropResult, bestResult!);
             cyl.placed = true;
        } else {
             const pos = this.exhaustiveSearch(cyl, bestResult!.placedBoxes);
             if (pos) {
               this.addPlacedCylinderToResult(cyl, { pos, orientation: 'horizontal-y' }, bestResult!);
               cyl.placed = true;
             }
        }
      }
    }

    const finalPlaced = bestResult!.placed;
    const finalUnplaced = all.filter(c => !c.placed).map(c => c.item);

    console.log(`Placed: ${finalPlaced.length}/${all.length}`);

    return {
      placedCylinders: finalPlaced,
      unplacedItems: finalUnplaced,
      statistics: this.calcStats(finalPlaced, finalUnplaced.length),
    };
  }

  // --- KESİNLEŞTİRİLMİŞ MANUEL STRATEJİ ---
  private packManualHeuristic(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    console.log("Running Manual Heuristic: Block 1 (24) -> Block 2 (14 Mixed) -> Tops (20 Horizontal)");
    allCylinders.forEach(c => c.placed = false);
    
    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];
    const placedCircles: PlacedCircle[] = []; 
    const placedObstacles: PlacedBox[] = []; 

    // TANIMLAR (KESİN)
    const is78x160 = (c: Cylinder) => Math.abs(c.diameter - 78) < 2 && Math.abs(c.length - 160) < 2;
    // Blok 2 SADECE 85 ve 97'likler. 78'ler BURAYA GİREMEZ.
    const isBlock2Vertical = (c: Cylinder) => !is78x160(c) && c.length >= 130 && c.length <= 150; 
    
    // Yatay Gruplar
    // Grup 1: 10 adet 77x152 + 2 adet 78x160 (Toplam 12) -> Blok 1 üstüne
    const isHorizForBlock1 = (c: Cylinder) => (Math.abs(c.diameter - 78) < 2 && Math.abs(c.length - 160) < 2) || (Math.abs(c.diameter - 77) < 2 && Math.abs(c.length - 152) < 2);
    // Grup 2: 8 adet 90x160 -> Blok 2 üstüne
    const isHorizForBlock2 = (c: Cylinder) => Math.abs(c.diameter - 90) < 2;

    const pool = [...allCylinders];
    
    // --- ADIM 1: BLOK 1 (TAM 24 ADET 78x160 - DİKEY) ---
    let block1Count = 0;
    // 78cm * 3 = 234cm. Konteyner 235cm.
    // 1cm adım (step) ile tam oturması lazım.
    for (let y = 0; y < this.L; y += 78) {
        for (let x = 0; x <= this.W - 78; x += 1) { // X step 1 yaptık
            if (block1Count >= 24) break;
            
            // Eğer bu x,y noktasında yer varsa (öncekilerle çakışmıyorsa)
            // Bu kontrolü `canPlace` ile değil manual grid mantığıyla yapıyoruz ama
            // x+=1 olduğu için çakışma olabilir, o yüzden collision check şart.
            if (this.canPlaceVerticalCircle(x, y, 78, 160, placedObstacles, placedCircles)) {
                const idx = pool.findIndex(c => !c.placed && is78x160(c));
                if (idx !== -1) {
                    const cyl = pool[idx];
                    const p = this.createVerticalPlacedCylinder(cyl, { x, y, z: 0 });
                    placed.push(p);
                    const box = this.getBoxFromPlaced(p);
                    placedBoxes.push(box);
                    placedCircles.push({ x: x + cyl.diameter/2, y: y + cyl.diameter/2, r: cyl.diameter/2 });
                    cyl.placed = true;
                    block1Count++;
                    
                    // Grid optimization: Bir tane koyduysak x'i çap kadar atlat
                    x += (cyl.diameter - 1); 
                }
            }
        }
        if (block1Count >= 24) break;
    }
    console.log(`Block 1 Placed: ${block1Count}/24`);

    // --- ADIM 2: BLOK 2 (KARIŞIK DİKEYLER - NESTING ŞART) ---
    // SADECE isBlock2Vertical (85 ve 97'ler). 78'ler buraya gelemez.
    let startYBlock2 = 0;
    placedBoxes.forEach(b => { if (b.yMax > startYBlock2) startYBlock2 = b.yMax; });
    startYBlock2 += 1; // Buffer

    const remainingVerticals = pool.filter(c => !c.placed && isBlock2Vertical(c));
    // Büyükten küçüğe sırala
    remainingVerticals.sort((a, b) => b.diameter - a.diameter);

    for (const cyl of remainingVerticals) {
        let found = false;
        // STEP = 1 (Hassas Nesting)
        for (let y = startYBlock2; y + cyl.diameter <= this.L; y += 1) {
            for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
                if (this.canPlaceVerticalCircle(x, y, cyl.diameter, cyl.length, placedObstacles, placedCircles)) {
                    const p = this.createVerticalPlacedCylinder(cyl, { x, y, z: 0 });
                    placed.push(p);
                    const box = this.getBoxFromPlaced(p);
                    placedBoxes.push(box); 
                    placedCircles.push({ x: x + cyl.diameter/2, y: y + cyl.diameter/2, r: cyl.diameter/2 });
                    cyl.placed = true;
                    found = true;
                    break;
                }
            }
            if (found) break;
        }
    }
    console.log(`Block 2 finished. Vertical count: ${placed.filter(p=>p.orientation==='vertical').length}`);

    // --- ADIM 3: ÜST KATMANLAR (YATAY - STEP 1) ---
    const horizontals = pool.filter(c => !c.placed);
    // Büyükten küçüğe
    horizontals.sort((a,b) => b.diameter - a.diameter);

    const topGroup1 = horizontals.filter(c => isHorizForBlock1(c)); // 77s ve 78s
    const topGroup2 = horizontals.filter(c => isHorizForBlock2(c)); // 90s

    // Top Group 1 (Blok 1 Üzerine)
    for (const cyl of topGroup1) {
        let found = false;
        // Blok 1 üzerinde Z > 150 ara. STEP = 1
        for (let y = 0; y < startYBlock2; y += 1) { 
            for (let x = 0; x <= this.W - cyl.diameter; x += 1) {
                const drop = this.findDropZ({x, y}, cyl.diameter, cyl.length, placedBoxes);
                // Z=160 (Blok 1) civarı kabul
                if (drop.z >= 155 && drop.z + cyl.diameter <= this.H) {
                    if (this.canPlace({x, y, z: drop.z}, cyl.diameter, cyl.length, placedBoxes)) {
                        const p = this.createPlacedCylinder(cyl, {x, y, z: drop.z});
                        placed.push(p);
                        const box = this.getBoxFromPlaced(p);
                        placedBoxes.push(box);
                        placedObstacles.push(box);
                        cyl.placed = true;
                        found = true;
                        break;
                    }
                }
            }
            if (found) break;
        }
    }

    // Top Group 2 (Blok 2 Üzerine)
    for (const cyl of topGroup2) {
        let found = false;
        // Blok 2 üzerinde Z > 130 ara. STEP = 1
        for (let y = startYBlock2 - 50; y + cyl.length <= this.L; y += 1) {
            for (let x = 0; x <= this.W - cyl.diameter; x += 1) {
                const drop = this.findDropZ({x, y}, cyl.diameter, cyl.length, placedBoxes);
                if (drop.z >= 130 && drop.z + cyl.diameter <= this.H) {
                    if (this.canPlace({x, y, z: drop.z}, cyl.diameter, cyl.length, placedBoxes)) {
                        const p = this.createPlacedCylinder(cyl, {x, y, z: drop.z});
                        placed.push(p);
                        const box = this.getBoxFromPlaced(p);
                        placedBoxes.push(box);
                        placedObstacles.push(box);
                        cyl.placed = true;
                        found = true;
                        break;
                    }
                }
            }
            if (found) break;
        }
    }

    // Leftovers (Hala kalan varsa)
    const leftovers = pool.filter(c => !c.placed);
    for (const cyl of leftovers) {
        const drop = this.tryDropPlacement(cyl, placedBoxes, 1); // Step 1
        if (drop) {
             this.addPlacedCylinderToResult(cyl, drop, {placed, placedBoxes} as any);
        }
    }

    const unplaced = pool.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  // --- HELPERS ---

  private canPlaceVerticalCircle(x: number, y: number, d: number, l: number, obstacles: PlacedBox[], circles: PlacedCircle[]): boolean {
      if (x < 0 || x + d > this.W) return false;
      if (y < 0 || y + d > this.L) return false;
      if (l > this.H) return false;

      const r = d / 2;
      const cx = x + r;
      const cy = y + r;

      // Dairelerle (staggering)
      for (const c of circles) {
          const dx = cx - c.x;
          const dy = cy - c.y;
          const distSq = dx*dx + dy*dy;
          const minR = r + c.r - 0.1; 
          if (distSq < minR * minR) return false;
      }

      // Yatay Engellerle
      for (const b of obstacles) {
          if (b.zMin < l) { 
             if (x < b.xMax && x + d > b.xMin && y < b.yMax && y + d > b.yMin) return false;
          }
      }
      return true;
  }

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
    placedBoxes: PlacedBox[],
    step: number = 1
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' } | null {
     
     const { diameter, length } = cyl;

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

  // (createPlacedCylinder, createVerticalPlacedCylinder, etc... öncekiyle aynı, buraya tam halini kopyalayabilirsiniz)
  // Koordinat dönüşümleri (Center) korundu.
  
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
      radius, length: cyl.length,
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
      radius, length: cyl.length,
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

  private addPlacedCylinderToResult(cyl: Cylinder, result: any, bestResult: any) {
      if (result.orientation === 'horizontal-y') {
        const p = this.createPlacedCylinder(cyl, result.pos);
        bestResult.placed.push(p);
        bestResult.placedBoxes.push(this.getBoxFromPlaced(p));
      } else if (result.orientation === 'horizontal-x') {
        const p = this.createRotatedPlacedCylinder(cyl, result.pos);
        bestResult.placed.push(p);
        bestResult.placedBoxes.push(this.getBoxFromPlaced(p));
      }
      cyl.placed = true;
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

  private packVerticalPriority(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packDifficultFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packMixedOrientations(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packHexagonal(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packCompact(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private exhaustiveSearch(cyl: any, placed: any[]) { return null; }

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
    return { placedCylinders: [], unplacedItems: [], statistics: { totalVolumePlaced: 0, containerVolumeUsed: 0, volumeEfficiency: 0, layerCount: 0, itemsPlaced: 0, itemsFailed: 0 } };
  }
}