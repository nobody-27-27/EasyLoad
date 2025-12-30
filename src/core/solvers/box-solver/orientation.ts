// src/core/solvers/box-solver/orientation.ts

import type { CargoItem, Dimensions } from '../../common/types';

/**
 * Bir koli için olası rotasyon varyasyonlarını tanımlar.
 */
export interface OrientedItem {
  originalItem: CargoItem;
  dimensions: Dimensions; // Döndürülmüş boyutlar
  rotation: { x: number; y: number; z: number }; // Radyan cinsinden (0 veya PI/2)
}

export class BoxOrientation {
  /**
   * Bir ürünün izin verilen tüm rotasyon varyasyonlarını döndürür.
   * Örneğin: Hem dik hem yan yatabiliyorsa, bu fonksiyon 2 veya daha fazla varyasyon döner.
   */
  static getPossibleOrientations(item: CargoItem): OrientedItem[] {
    const variants: OrientedItem[] = [];
    const { width, length, height } = item.dimensions;

    // 1. Varsayılan Duruş (0, 0, 0)
    variants.push({
      originalItem: item,
      dimensions: { width, length, height },
      rotation: { x: 0, y: 0, z: 0 },
    });

    // 2. Zemin üzerinde 90 derece dönüş (Y Ekseni etrafında)
    // Koli eni ve boyu yer değiştirir.
    if (item.allowedRotation.y) {
      variants.push({
        originalItem: item,
        dimensions: { width: length, length: width, height: height },
        rotation: { x: 0, y: Math.PI / 2, z: 0 },
      });
    }

    // 3. Yan yatırma (X Ekseni etrafında - Devirme)
    // Koli yüksekliği ile eni/boyu yer değiştirir.
    if (item.allowedRotation.x) {
      // a) Yana devirme (En ve Yükseklik yer değişir)
      variants.push({
        originalItem: item,
        dimensions: { width: height, length: length, height: width },
        rotation: { x: Math.PI / 2, y: 0, z: 0 },
      });

      // b) Yana devirip bir de çevirme (Eğer Y rotasyonu da varsa)
      if (item.allowedRotation.y) {
        variants.push({
          originalItem: item,
          dimensions: { width: length, length: height, height: width },
          rotation: { x: Math.PI / 2, y: Math.PI / 2, z: 0 },
        });
      }
    }

    // Not: Z ekseni rotasyonu (Tekerlek gibi yuvarlanma) genelde kolilerde kullanılmaz,
    // o yüzden şimdilik kapsam dışı bırakıyoruz.

    return variants;
  }
}
