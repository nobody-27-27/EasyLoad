// src/core/solvers/box-solver/wall-builder.ts

import type { Container, CargoItem, PlacedItem } from '../../common/types';

interface FreeBlock {
  x: number;
  y: number; // Derinlik
  z: number; // Yükseklik
  width: number;
  length: number;
  height: number;
}

export class WallBuilder {
  private items: CargoItem[];
  private freeBlocks: FreeBlock[] = [];

  constructor(container: Container, items: CargoItem[]) {
    this.items = items;

    // Konteyneri başlangıçta tek büyük boşluk olarak tanımla
    this.freeBlocks.push({
      x: 0,
      y: 0,
      z: 0,
      width: container.dimensions.width,
      length: container.dimensions.length,
      height: container.dimensions.height,
    });
  }

  public solve(): PlacedItem[] {
    const placedItems: PlacedItem[] = [];

    // 1. Ürünleri Tekilleştir
    let allItems: CargoItem[] = [];
    this.items.forEach((item) => {
      for (let i = 0; i < item.quantity; i++) {
        allItems.push({ ...item, quantity: 1 });
      }
    });

    // 2. Sıralama: Duvar örmek için Yükseklik > Boyut önceliği
    allItems.sort((a, b) => {
      if (b.dimensions.height !== a.dimensions.height)
        return b.dimensions.height - a.dimensions.height;
      const volA =
        a.dimensions.width * a.dimensions.length * a.dimensions.height;
      const volB =
        b.dimensions.width * b.dimensions.length * b.dimensions.height;
      return volB - volA;
    });

    // 3. Yerleştirme
    for (const item of allItems) {
      const bestFit = this.findBestSpot(item);

      if (bestFit) {
        placedItems.push({
          ...item,
          uniqueId: `${item.id}_box_${placedItems.length}`,
          position: {
            x: bestFit.block.x,
            y: bestFit.block.y,
            z: bestFit.block.z,
          },
          rotation: { x: 0, y: bestFit.rotated ? Math.PI / 2 : 0, z: 0 },
          dimensions: bestFit.rotated
            ? {
                ...item.dimensions,
                width: item.dimensions.length,
                length: item.dimensions.width,
              }
            : item.dimensions,
        });

        // Alanı Parçala
        this.splitFreeBlock(
          bestFit.blockIndex,
          bestFit.placedWidth,
          bestFit.placedLength,
          bestFit.placedHeight
        );

        // Temizlik
        this.mergeBlocks();
      }
    }

    return placedItems;
  }

  private findBestSpot(item: CargoItem) {
    let bestSpot = null;
    let minScore = Number.MAX_VALUE;

    // --- PUANLAMA SİSTEMİ (Önemli) ---
    // Y (Derinlik) cezası devasa olmalı ki arka taraf bitmeden öne gelmesin.
    // Z (Yükseklik) cezası orta olmalı ki zemin bitmeden üste çıkmasın.
    // X (Genişlik) cezası düşük, soldan sağa doldurur.
    const SCORE_Y = 1_000_000;
    const SCORE_Z = 1_000;
    const SCORE_X = 1;

    for (let i = 0; i < this.freeBlocks.length; i++) {
      const block = this.freeBlocks[i];
      const { width: w, length: l, height: h } = item.dimensions;

      // 1. Normal Duruş
      if (w <= block.width && l <= block.length && h <= block.height) {
        const score = block.y * SCORE_Y + block.z * SCORE_Z + block.x * SCORE_X;
        if (score < minScore) {
          minScore = score;
          bestSpot = {
            blockIndex: i,
            block,
            rotated: false,
            placedWidth: w,
            placedLength: l,
            placedHeight: h,
          };
        }
      }

      // 2. Döndürülmüş Duruş (W <-> L)
      if (item.allowedRotation.y) {
        const rotW = l;
        const rotL = w;
        if (rotW <= block.width && rotL <= block.length && h <= block.height) {
          const score =
            block.y * SCORE_Y + block.z * SCORE_Z + block.x * SCORE_X;
          if (score < minScore) {
            minScore = score;
            bestSpot = {
              blockIndex: i,
              block,
              rotated: true,
              placedWidth: rotW,
              placedLength: rotL,
              placedHeight: h,
            };
          }
        }
      }
    }

    return bestSpot;
  }

  /**
   * YENİ KESİM STRATEJİSİ: "Derinlemesine Sağ Blok"
   * Sağda kalan boşluğun (RightBlock) derinliğini kısıtlamıyoruz.
   * Böylece dar ama uzun parçalar (40x60 gibi) oraya sığabiliyor.
   */
  private splitFreeBlock(
    blockIndex: number,
    usedW: number,
    usedL: number,
    usedH: number
  ) {
    const block = this.freeBlocks[blockIndex];
    this.freeBlocks.splice(blockIndex, 1);

    // 1. ÜST PARÇA (Top)
    // Yerleşen kutunun tam üstü. Genişlik ve Derinlik kısıtlı değil, ana bloğu korur.
    // Bu, "raf" mantığıyla üst üste dizmeyi kolaylaştırır.
    const topBlock: FreeBlock = {
      x: block.x,
      y: block.y,
      z: block.z + usedH,
      width: block.width,
      length: block.length,
      height: block.height - usedH,
    };

    // 2. YAN PARÇA (Right) - KRİTİK DEĞİŞİKLİK BURADA
    // Eskiden: length: usedL yapıyorduk (Derinliği kısıtlıyorduk).
    // Şimdi: length: block.length yapıyoruz (Sonuna kadar git).
    // Böylece 55cm'lik boşluğa 60cm derinliğinde bir kutu koyabiliyoruz.
    const rightBlock: FreeBlock = {
      x: block.x + usedW,
      y: block.y,
      z: block.z,
      width: block.width - usedW,
      length: block.length, // <--- TAM DERİNLİK KULLAN
      height: usedH, // Sadece kullanılan yükseklik (Üstü TopBlock'a ait)
    };

    // 3. ÖN PARÇA (Front)
    // Sağ parça derinlemesine uzadığı için, ön parçanın genişliğini kısıtlamalıyız.
    // Yoksa Sağ ve Ön parçalar çakışır.
    const frontBlock: FreeBlock = {
      x: block.x,
      y: block.y + usedL,
      z: block.z,
      width: usedW, // <--- SADECE KUTUNUN GENİŞLİĞİ KADAR
      length: block.length - usedL,
      height: usedH,
    };

    // Hacmi olan blokları ekle
    if (topBlock.height > 0 && topBlock.width > 0 && topBlock.length > 0)
      this.freeBlocks.push(topBlock);
    if (rightBlock.height > 0 && rightBlock.width > 0 && rightBlock.length > 0)
      this.freeBlocks.push(rightBlock);
    if (frontBlock.height > 0 && frontBlock.width > 0 && frontBlock.length > 0)
      this.freeBlocks.push(frontBlock);
  }

  private mergeBlocks() {
    this.freeBlocks = this.freeBlocks.filter(
      (b) => b.width >= 1 && b.length >= 1 && b.height >= 1
    );
  }
}
