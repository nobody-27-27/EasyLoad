// src/core/math/pallet-math/guillotine.ts

/**
 * 2D Uzayda Boşluk Tanımı
 */
export interface FreeRect {
  x: number;
  y: number;
  width: number;
  length: number;
}

export class GuillotinePacker {
  private freeRectangles: FreeRect[] = [];

  constructor(width: number, length: number) {
    // Başlangıçta tüm konteyner zemini tek bir büyük boşluktur
    this.freeRectangles.push({ x: 0, y: 0, width, length });
  }

  /**
   * Verilen boyuttaki (w, l) bir cisim için en uygun boşluğu arar.
   * "Best Area Fit" kuralını kullanır (En az fire verecek boşluğu seçer).
   */
  public findPosition(
    w: number,
    l: number
  ): { x: number; y: number; index: number } | null {
    let bestScore = Number.MAX_VALUE;
    let bestRectIndex = -1;
    let bestRect: FreeRect | null = null;

    for (let i = 0; i < this.freeRectangles.length; i++) {
      const free = this.freeRectangles[i];

      // Sığıyor mu?
      if (w <= free.width && l <= free.length) {
        // Skor hesapla: Kalan alan ne kadar küçükse o kadar iyidir (Tight Fit)
        const areaFit = free.width * free.length - w * l;

        if (areaFit < bestScore) {
          bestScore = areaFit;
          bestRectIndex = i;
          bestRect = free;
        }
      }
    }

    if (bestRectIndex !== -1 && bestRect) {
      return { x: bestRect.x, y: bestRect.y, index: bestRectIndex };
    }

    return null;
  }

  /**
   * Bir parça yerleştirildikten sonra, kullanılan boşluğu (rect) parçalar.
   * "Giyotin" gibi keserek iki yeni küçük boşluk oluşturur.
   */
  public splitFreeRect(freeRectIndex: number, usedW: number, usedL: number) {
    const free = this.freeRectangles[freeRectIndex];

    // Giyotin Kesim Mantığı:
    // L şeklindeki kalan alanı iki dikdörtgene bölmenin iki yolu vardır:
    // 1. Yatay Kesim (Horizontal Split)
    // 2. Dikey Kesim (Vertical Split)
    // Hangi kenar daha kısaysa oradan kesmek genelde daha büyük bütün parçalar bırakır.

    // Yeni oluşacak boşluklar
    // Altta kalan boşluk (Kullanılanın yanı)
    const rightRect: FreeRect = {
      x: free.x + usedW,
      y: free.y,
      width: free.width - usedW,
      length: usedL,
    };

    // Üstte kalan boşluk (Kullanılanın üstü - Boydan boya)
    const topRect: FreeRect = {
      x: free.x,
      y: free.y + usedL,
      width: free.width, // Tam genişlik
      length: free.length - usedL,
    };

    // Kullanılan eski büyük boşluğu sil
    this.freeRectangles.splice(freeRectIndex, 1);

    // Yeni küçük boşlukları ekle (Eğer boyutları 0'dan büyükse)
    if (rightRect.width > 0 && rightRect.length > 0) {
      this.freeRectangles.push(rightRect);
    }
    if (topRect.width > 0 && topRect.length > 0) {
      this.freeRectangles.push(topRect);
    }

    // Küçük parçaların büyük parçaların içinde kaybolmasını engellemek için birleştirme (Merge)
    // yapılabilir ama temel Giyotin için şart değil.
  }
}
