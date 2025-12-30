// src/core/common/support-grid.ts

/**
 * Destek Izgarası (Support Map)
 * Konteyner tabanını küçük karelere (hücrelere) böler.
 * Her hücrede, o noktadaki maksimum yükseklik bilgisini tutar.
 * Bu sayede "Şu koordinatta zemin yüksekliği nedir?" sorusuna cevap veririz.
 */

export interface SupportMap {
  resolution: number; // Her hücrenin boyutu (Örn: 5cm x 5cm)
  width: number; // Grid genişliği (Hücre sayısı)
  length: number; // Grid uzunluğu (Hücre sayısı)
  heights: number[][]; // 2D Matris: heights[x][y] = O noktadaki yükseklik (cm)
}

/**
 * Bir alanın düz ve destekli olup olmadığını kontrol eden fonksiyonların imzası.
 */
export interface ISupportChecker {
  /**
   * Belirtilen alanın (x, y, width, length) altındaki zemin yüksekliğini kontrol eder.
   * Eğer alan homojen değilse (çukurlar varsa) yerleştirmeye izin vermez.
   */
  getAverageHeight(x: number, y: number, w: number, l: number): number;

  /**
   * Belirtilen alanın tamamen düz olup olmadığını döner.
   */
  isAreaFlat(
    x: number,
    y: number,
    w: number,
    l: number,
    tolerance?: number
  ): boolean;
}
