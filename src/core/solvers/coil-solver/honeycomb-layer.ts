// src/core/solvers/coil-solver/honeycomb-layer.ts

import type { Container, CargoItem, PlacedItem } from '../../common/types';

interface Point3D {
  x: number;
  y: number;
  z: number;
}

export class HoneycombLayerBuilder {
  private container: Container;
  private placedItems: PlacedItem[] = [];
  private candidatePoints: Point3D[] = [];

  constructor(container: Container) {
    this.container = container;
  }

  // --- ANA ÇÖZÜCÜ ---
  public solveEverything(items: CargoItem[]): PlacedItem[] {
    this.placedItems = [];
    // Başlangıç noktası: Sol-Alt-Arka köşe
    this.candidatePoints = [{ x: 0, y: 0, z: 0 }];

    const queue = this.flattenItems(items);

    // Her ürün için döngü
    for (const item of queue) {
      let bestMove: {
        pos: Point3D;
        rot: { x: number; y: number; z: number };
        score: number;
      } | null = null;
      let usedCandidateIndex = -1;

      // 1. MEVCUT ADAY NOKTALARI TARA
      // Sort candidates: Y (Back) -> Z (Bottom) -> X (Left)
      this.candidatePoints.sort((a, b) => {
        if (Math.abs(a.y - b.y) > 0.1) return a.y - b.y;
        if (Math.abs(a.z - b.z) > 0.1) return a.z - b.z;
        return a.x - b.x;
      });

      for (let i = 0; i < this.candidatePoints.length; i++) {
        const point = this.candidatePoints[i];

        // Puan limiti: Eğer şu anki nokta zaten bulduğumuz en iyi skordan kötüyse bakma bile
        // (Optimizasyon)
        // const currentPointBaseScore = (point.y * 10000) + (point.z * 100) + point.x;
        // if (bestMove && currentPointBaseScore > bestMove.score) continue;

        // 3 ROTASYONU DENE
        const possibleRotations = [
          { x: 0, y: 0, z: 0 }, // DİK
          { x: Math.PI / 2, y: 0, z: 0 }, // YATIK (Boyuna)
          { x: 0, y: 0, z: Math.PI / 2 }, // YAN (Enine)
        ];

        for (const rot of possibleRotations) {
          // Sığıyor mu?
          if (this.canFit(point, item, rot)) {
            const score = this.calculateScore(point, item, rot);

            if (!bestMove || score < bestMove.score) {
              bestMove = { pos: point, rot: rot, score: score };
              usedCandidateIndex = i;
            }
          }
        }
      }

      // 2. YERLEŞTİR
      if (bestMove) {
        const newItem: PlacedItem = {
          ...item,
          uniqueId: `${item.id}_${Math.random().toString(36).substr(2, 6)}`,
          position: bestMove.pos,
          rotation: bestMove.rot,
          dimensions: item.dimensions,
        };
        this.placedItems.push(newItem);

        // 3. YENİ NOKTALAR ÜRET
        // Yerleşen cismin uzaydaki boyutlarını al
        const dim = this.getDimensionsFromProps(item, bestMove.rot);

        // 3 Yeni Nokta:
        // 1. Sağ tarafı (X+)
        this.addCandidate({
          x: bestMove.pos.x + dim.x,
          y: bestMove.pos.y,
          z: bestMove.pos.z,
        });
        // 2. Arka tarafı (Y+) -> Duvar örmek için kritik
        this.addCandidate({
          x: bestMove.pos.x,
          y: bestMove.pos.y + dim.y,
          z: bestMove.pos.z,
        });
        // 3. Üst tarafı (Z+) -> İstiflemek için kritik
        this.addCandidate({
          x: bestMove.pos.x,
          y: bestMove.pos.y,
          z: bestMove.pos.z + dim.z,
        });

        // Not: Kullanılan noktayı listeden silmiyoruz çünkü o noktaya başka (daha küçük) bir şey sığabilir mi?
        // Hayır, o köşe artık dolu. Ama kesişim testi (canFit) zaten bunu kontrol eder.
        // Yine de temizlik iyidir:
        // (Gelişmiş versiyonda "Invalidate" yapılır ama şimdilik kalsın, canFit koruyor)
      } else {
        console.warn(
          `Sığmadı: ${item.name} (${item.dimensions.width}x${item.dimensions.height})`
        );
      }
    }

    return this.placedItems;
  }

  // --- ÇARPIŞMA TESTİ (KESİN VE NET) ---
  private canFit(
    pos: Point3D,
    item: CargoItem,
    rot: { x: number; y: number; z: number }
  ): boolean {
    // 1. Boyutları Hesapla
    const dim = this.getDimensionsFromProps(item, rot);

    // 2. Sınır Kontrolü (Tolerans 0.01)
    if (pos.x + dim.x > this.container.dimensions.width + 0.01) return false;
    if (pos.y + dim.y > this.container.dimensions.length + 0.01) return false;
    if (pos.z + dim.z > this.container.dimensions.height + 0.01) return false;

    // 3. Çakışma Kontrolü (Diğer kutularla)
    // Shrink slightly to avoid touching surfaces being counted as overlap
    const EPSILON = 0.05;

    for (const placed of this.placedItems) {
      const pDim = this.getDimensionsFromProps(placed, placed.rotation); // PlacedItem aslında CargoItem prop'larını taşır

      // AABB Intersection Test
      const isOverlapping =
        pos.x < placed.position.x + pDim.x - EPSILON &&
        pos.x + dim.x > placed.position.x + EPSILON &&
        pos.y < placed.position.y + pDim.y - EPSILON &&
        pos.y + dim.y > placed.position.y + EPSILON &&
        pos.z < placed.position.z + pDim.z - EPSILON &&
        pos.z + dim.z > placed.position.z + EPSILON;

      if (isOverlapping) return false;
    }

    return true;
  }

  // --- PUANLAMA ---
  private calculateScore(
    pos: Point3D,
    item: CargoItem,
    rot: { x: number; y: number; z: number }
  ): number {
    // Strateji: Derinlik (Y) -> Yükseklik (Z) -> Genişlik (X)
    // En arkaya, en alta ve en sola koymaya çalış.

    let score = pos.y * 100000 + pos.z * 1000 + pos.x;

    // --- ÖZEL HEURISTICLER ---

    // 1. Uzun parçaları (Boy > Çap) YATIK koymayı teşvik et (-500 puan)
    // Çünkü 160cm boyundaki bir şeyi dik koymak denge için kötüdür.
    if (
      Math.abs(rot.x) > 0.1 &&
      item.dimensions.height > item.dimensions.width
    ) {
      score -= 500;
    }

    return score;
  }

  // --- BOYUT HESAPLAMA ---
  private getDimensionsFromProps(
    item: CargoItem,
    rot: { x: number; y: number; z: number }
  ): { x: number; y: number; z: number } {
    // Logic:
    // DİK (0,0,0) -> X=Çap, Y=Çap, Z=Boy
    if (Math.abs(rot.x) < 0.1 && Math.abs(rot.z) < 0.1) {
      return {
        x: item.dimensions.width,
        y: item.dimensions.width,
        z: item.dimensions.height,
      };
    }
    // YATIK (90,0,0) -> X=Çap, Y=Boy, Z=Çap
    if (Math.abs(rot.x) > 0.1) {
      return {
        x: item.dimensions.width,
        y: item.dimensions.height,
        z: item.dimensions.width,
      };
    }
    // YAN (0,0,90) -> X=Boy, Y=Çap, Z=Çap
    if (Math.abs(rot.z) > 0.1) {
      return {
        x: item.dimensions.height,
        y: item.dimensions.width,
        z: item.dimensions.width,
      };
    }
    // Varsayılan Dik
    return {
      x: item.dimensions.width,
      y: item.dimensions.width,
      z: item.dimensions.height,
    };
  }

  // --- ADAY NOKTA EKLEME ---
  private addCandidate(p: Point3D) {
    // Sınır dışı kontrolü
    if (
      p.x >= this.container.dimensions.width ||
      p.y >= this.container.dimensions.length ||
      p.z >= this.container.dimensions.height
    )
      return;

    // Duplicate kontrolü (Toleranslı)
    const exists = this.candidatePoints.some(
      (cp) =>
        Math.abs(cp.x - p.x) < 0.1 &&
        Math.abs(cp.y - p.y) < 0.1 &&
        Math.abs(cp.z - p.z) < 0.1
    );

    if (!exists) {
      this.candidatePoints.push(p);
    }
  }

  private flattenItems(items: CargoItem[]): CargoItem[] {
    const queue: CargoItem[] = [];
    items.forEach((item) => {
      for (let i = 0; i < item.quantity; i++)
        queue.push({ ...item, quantity: 1 });
    });
    return queue;
  }

  // Interface uyumluluğu için boş metodlar
  public solveVertical(s: number, m: number, i: CargoItem[]) {
    return [];
  }
  public solveHorizontal(s: number, i: CargoItem[]) {
    return [];
  }
}
