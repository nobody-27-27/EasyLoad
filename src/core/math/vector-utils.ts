// src/core/math/vector-utils.ts
import type { Vector3, Dimensions } from '../common/types';

const EPSILON = 0.001; // 1mm hata payı toleransı

export const VectorUtils = {
  /**
   * İki nokta arasındaki Öklid mesafesini hesaplar.
   * d = sqrt((x2-x1)^2 + (y2-y1)^2 + (z2-z1)^2)
   */
  distance: (v1: Vector3, v2: Vector3): number => {
    const dx = v1.x - v2.x;
    const dy = v1.y - v2.y;
    const dz = v1.z - v2.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  },

  /**
   * İki float değerin "eşit" olup olmadığını toleransla kontrol eder.
   */
  areEqual: (a: number, b: number): boolean => {
    return Math.abs(a - b) < EPSILON;
  },

  /**
   * Boyutları döndürür.
   * Örn: Y ekseninde (yerde) 90 derece dönerse En ve Boy yer değiştirir.
   */
  rotateDimensions: (
    dims: Dimensions,
    rotation: { x: boolean; y: boolean; z: boolean }
  ): Dimensions => {
    let { width, length, height } = dims;

    // Basit mantık: Eğer Y ekseninde (zemin) dönüyorsa En ve Boy yer değişir
    if (rotation.y) {
      [width, length] = [length, width];
    }

    // Eğer X ekseninde (yan) yatıyorsa (Rulo veya Koli devrilmesi)
    if (rotation.x) {
      [width, height] = [height, width]; // Genişlik ve Yükseklik yer değişir (Basit yaklaşım)
    }

    return { width, length, height };
  },
};
