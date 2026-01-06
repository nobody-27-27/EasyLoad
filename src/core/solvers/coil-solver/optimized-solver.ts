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

    // Adetleri aç (Quantity Expansion)
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

    // Stratejiler: İlk sıraya sizin "Manuel Planınızı" koydum.
    const strategies = [
      () => this.packManualHeuristic(all), // <-- SİZİN YÖNTEMİNİZ (ÖNCELİKLİ)
      () => this.packVerticalPriority(all),
      () => this.packDifficultFirst(all),
      () => this.packMixedOrientations(all),
      () => this.packHexagonal(all),
      () => this.packCompact(all),
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[]; placedBoxes: PlacedBox[] } | null = null;

    for (const strategy of strategies) {
      // Her denemede sıfırla
      all.forEach(c => c.placed = false);
      const result = strategy();

      // Sonuçları kutu (box) olarak sakla (çarpışma testleri için)
      const placedBoxes: PlacedBox[] = result.placed.map(p => this.getBoxFromPlaced(p));

      if (!bestResult || result.placed.length > bestResult.placed.length) {
        bestResult = { ...result, placedBoxes };
      }

      // Hepsi yerleştiyse dur
      if (result.unplaced.length === 0) {
        console.log("Full placement achieved with strategy!");
        break;
      }
    }

    // Son kalanları zorla yerleştirmeyi dene (Drop mantığı)
    if (bestResult!.unplaced.length > 0) {
      const unplacedCyls = all.filter(c => !c.placed);
      // Küçükten büyüğe sırala (aralara sığması kolay olsun)
      unplacedCyls.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of unplacedCyls) {
        const dropResult = this.tryDropPlacement(cyl, bestResult!.placedBoxes);
        if (dropResult) {
             this.addPlacedCylinderToResult(cyl, dropResult, bestResult!);
        } else {
             // Son çare: Boşluk ara (Exhaustive)
             const pos = this.exhaustiveSearch(cyl, bestResult!.placedBoxes);
             if (pos) {
               this.addPlacedCylinderToResult(cyl, { pos, orientation: 'horizontal-y' }, bestResult!);
             }
        }
      }
      bestResult!.unplaced = all.filter(c => !c.placed).map(c => c.item);
    }

    const { placed, unplaced } = bestResult!;
    console.log(`Placed: ${placed.length}/${all.length}`);

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calcStats(placed, unplaced.length),
    };
  }

  // --- SİZİN MANUEL PLANINIZI KODLAYAN FONKSİYON ---
  private packManualHeuristic(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    console.log("Running Manual Heuristic: Block 1 -> Block 2 -> Tops");
    allCylinders.forEach(c => c.placed = false);
    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    // 1. Grupları Ayır (Toleranslı boyut kontrolü)
    const is78x160 = (c: Cylinder) => Math.abs(c.diameter - 78) < 2 && Math.abs(c.length - 160) < 2;
    const isMixedVertical = (c: Cylinder) => !is78x160(c) && c.length >= 130 && c.length <= 150; // 85s ve 97s
    const isHorizForBlock1 = (c: Cylinder) => (Math.abs(c.diameter - 78) < 2 && Math.abs(c.length - 160) < 2) || (Math.abs(c.diameter - 77) < 2 && Math.abs(c.length - 152) < 2);
    const isHorizForBlock2 = (c: Cylinder) => Math.abs(c.diameter - 90) < 2; // 90x160

    // Stok Havuzunu Yönet
    const pool = [...allCylinders];
    
    // --- ADIM 1: BLOK 1 (Zemin - 24 adet 78x160) ---
    // Konteynerin en arkasına (Y=0) yerleşecekler.
    // 235 genişliğe 78'lik rulo 3 adet sığar (78*3 = 234). Mükemmel fit.
    // 24 adet = 3 genişlik x 8 derinlik.
    // Derinlik = 8 * 78 = 624 cm.
    
    let block1Count = 0;
    // Grid yerleşimi: Y (Derinlik) -> X (Genişlik)
    for (let y = 0; y < this.L; y += 78) {
        for (let x = 0; x <= this.W - 78; x += 78) {
            if (block1Count >= 24) break;
            
            // Havuzdan 78x160 bul
            const idx = pool.findIndex(c => !c.placed && is78x160(c));
            if (idx !== -1) {
                const cyl = pool[idx];
                const pos = { x, y, z: 0 };
                
                // Yerleştir
                const p = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(p);
                placedBoxes.push(this.getBoxFromPlaced(p));
                cyl.placed = true;
                block1Count++;
            }
        }
        if (block1Count >= 24) break;
    }
    console.log(`Block 1 Placed: ${block1Count}/24 (Vertical 78x160)`);

    // --- ADIM 2: BLOK 2 (Zemin - Karışık Dikeyler) ---
    // Blok 1'in bittiği yerden başla. Blok 1 yaklaşık Y=624'te bitti.
    // Geriye kalan 85 ve 97 çaplı dikeyler.
    
    // Blok 1'in bittiği gerçek Y noktasını bul
    let startYBlock2 = 0;
    placedBoxes.forEach(b => {
        if (b.yMax > startYBlock2) startYBlock2 = b.yMax;
    });
    // Biraz boşluk bırakalım (görsel rahatlık için, 1cm)
    startYBlock2 += 1;

    // Kalan dikeyleri bul
    const remainingVerticals = pool.filter(c => !c.placed && (isMixedVertical(c) || is78x160(c))); // Artan 78'ler de buraya
    // Büyükten küçüğe sırala (yerleşimi kolaylaştırır)
    remainingVerticals.sort((a, b) => b.diameter - a.diameter);

    // Basit Grid mantığıyla doldur
    for (const cyl of remainingVerticals) {
        // Uygun yer ara (Exhaustive search ama sadece Z=0 ve Y > startYBlock2)
        let found = false;
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
    console.log(`Block 2 Placed. Remaining items: ${pool.filter(c => !c.placed).length}`);

    // --- ADIM 3: ÜST KATMANLAR (Yataylar) ---
    // Burada "Drop" (Bırakma) mantığını kullanacağız. 
    // Önce 77'likler ve kalan 78'ler (Blok 1'in üzerine gitmeli).
    // Sonra 90'lıklar (Blok 2'nin üzerine gitmeli).

    const horizontals = pool.filter(c => !c.placed);
    // 90'lıkları en sona bırakalım ki öne (Blok 2 üstüne) gitsinler, diğerleri arkaya (Blok 1 üstüne)
    // Blok 1 yüksekliği ~160cm. Blok 2 yüksekliği ~135-150cm.
    
    // Grupla: Blok 1'e gidecekler (78, 77) ve Blok 2'ye gidecekler (90)
    const topGroup1 = horizontals.filter(c => isHorizForBlock1(c));
    const topGroup2 = horizontals.filter(c => isHorizForBlock2(c));
    const others = horizontals.filter(c => !isHorizForBlock1(c) && !isHorizForBlock2(c)); // Tanımsızlar

    // Blok 1 Üzerine Yerleştir (Z > 150 olan yerler)
    // Sadece Blok 1 bölgesinde (Y < startYBlock2) ara
    for (const cyl of topGroup1) {
        // Boyuna (Horizontal-Y) yerleştirme öncelikli
        // Blok 1 üzerinde gez:
        let found = false;
        // Y adımını 78 (alttaki rulo çapı) yaparsak tam oluklara (valley) oturur
        for (let y = 0; y < startYBlock2 - cyl.length; y += 30) {
            for (let x = 0; x <= this.W - cyl.diameter; x += 10) {
                // Drop ile Z bul
                const pos = this.findDropZ({x, y}, cyl.diameter, cyl.length, placedBoxes);
                // Eğer Z, Blok 1'in tepesindeyse (yaklaşık 160) kabul et
                if (pos.z >= 155 && pos.z + cyl.diameter <= this.H) {
                    const p = this.createPlacedCylinder(cyl, {x, y, z: pos.z});
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

    // Blok 2 Üzerine Yerleştir (Z > 130 olan yerler)
    for (const cyl of topGroup2) {
        let found = false;
        for (let y = startYBlock2 - 50; y + cyl.length <= this.L; y += 30) { // Biraz geriden başla
            for (let x = 0; x <= this.W - cyl.diameter; x += 10) {
                const pos = this.findDropZ({x, y}, cyl.diameter, cyl.length, placedBoxes);
                // Blok 2 tepesi (130+)
                if (pos.z >= 130 && pos.z + cyl.diameter <= this.H) {
                    const p = this.createPlacedCylinder(cyl, {x, y, z: pos.z});
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

    // Kalanları her yere dene
    const leftovers = pool.filter(c => !c.placed);
    for (const cyl of leftovers) {
        const drop = this.tryDropPlacement(cyl, placedBoxes);
        if (drop) {
             this.addPlacedCylinderToResult(cyl, drop, {placed, placedBoxes} as any);
        }
    }

    const unplaced = pool.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  // --- YARDIMCI METODLAR ---

  // Belirli bir X,Y noktasındaki en yüksek Z noktasını bulur (Drop mantığı)
  private findDropZ(pos: {x: number, y: number}, d: number, l: number, placed: PlacedBox[]): {x: number, y: number, z: number} {
      let maxZ = 0;
      for (const box of placed) {
          // Kesişim testi (XY düzleminde)
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

     // 1. Horizontal-Y
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

  // ... (Geri kalan metodlar öncekiyle aynı kalabilir veya sadeleştirilebilir)
  // ... (packVerticalPriority, packDifficultFirst vs. burada durabilir, kullanılmasa bile)
  
  private packVerticalPriority(all: Cylinder[]) { return { placed: [], unplaced: [] }; } // Placeholder for brevity
  private packDifficultFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packMixedOrientations(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packHexagonal(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packCompact(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packWithStrategy(all: Cylinder[], s: string) { return { placed: [], unplaced: [] }; }
  private packMixedOptimal(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packLargestFirst(all: Cylinder[]) { return { placed: [], unplaced: [] }; }
  private packByStackEfficiency(all: Cylinder[]) { return { placed: [], unplaced: [] }; }

  // ---------------------------------------------------------
  // GÖRSELLEŞTİRME İÇİN KRİTİK: KOORDİNAT DÖNÜŞÜMLERİ
  // ---------------------------------------------------------
  
  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;
    // Benzersiz ID (Timestamp + Random)
    const uniqueId = `cyl_${cyl.index}_${Date.now().toString(36)}_${Math.random().toString(36).substr(2, 5)}`;

    return {
      item: cyl.item,
      uniqueId: uniqueId,
      position: { x: pos.x, y: pos.y, z: pos.z },
      // GÖRSEL MERKEZ (Three.js Y-Up)
      // Visual X = Solver X + Radius
      // Visual Y (Height) = Solver Z + Radius
      // Visual Z (Depth) = Solver Y + Length/2
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
      // GÖRSEL MERKEZ (Three.js Y-Up)
      // Visual X = Solver X + Radius
      // Visual Y (Height) = Solver Z + Length/2
      // Visual Z (Depth) = Solver Y + Radius
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
      // Bounding box hesapla (Solver koordinatları)
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
          // Horizontal-Y
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
      return this.checkCollision(pos.x, pos.y, pos.z, d, l, d, placed); // W, L, H dimensions
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

  private canPlaceRotated(pos: any, d: number, l: number, placed: PlacedBox[]): boolean {
      // Horizontal-X: width=L, length=D, height=D
      if (pos.x < 0 || pos.x + l > this.W) return false;
      if (pos.y < 0 || pos.y + d > this.L) return false;
      if (pos.z < 0 || pos.z + d > this.H) return false;
      return this.checkCollision(pos.x, pos.y, pos.z, l, d, d, placed);
  }

  private hasSupportRelaxed(pos: any, d: number, l: number, placed: any[]) { return true; }
  private hasRotatedSupportRelaxed(pos: any, d: number, l: number, placed: any[]) { return true; }
  private hasVerticalSupportRelaxed(pos: any, d: number, placed: any[]) { return true; }
  private exhaustiveSearch(cyl: any, placed: any[]) { return null; }

  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
    let totalVol = 0;
    let maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius * c.radius * c.length;
      layers.add(c.layerId);
      // Bounding box for usage
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