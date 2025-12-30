// src/core/math/box-math/aabb.ts
import type { Vector3, Dimensions } from '../../common/types';

/**
 * AABB (Axis-Aligned Bounding Box)
 * Kutular eksenlere paraleldir (eğik durmazlar), bu yüzden hesaplama çok hızlıdır.
 */

export class AABBScanner {
  /**
   * İki kutunun kesişip kesişmediğini kontrol eder.
   * Eğer herhangi bir eksende (X, Y veya Z) ayrıklarsa, çarpışma yoktur.
   */
  static doBoxesIntersect(
    pos1: Vector3,
    dim1: Dimensions,
    pos2: Vector3,
    dim2: Dimensions,
    gap: number = 0 // Opsiyonel güvenlik boşluğu
  ): boolean {
    // Kutu 1 Sınırları
    const minX1 = pos1.x;
    const maxX1 = pos1.x + dim1.width;
    const minY1 = pos1.y;
    const maxY1 = pos1.y + dim1.length; // Bizim sistemde Y derinliktir
    const minZ1 = pos1.z;
    const maxZ1 = pos1.z + dim1.height;

    // Kutu 2 Sınırları (Gap dahil edilir - yani kutu 2 sanal olarak biraz daha büyük düşünülür)
    const minX2 = pos2.x + gap;
    const maxX2 = pos2.x + dim2.width - gap;
    const minY2 = pos2.y + gap;
    const maxY2 = pos2.y + dim2.length - gap;
    const minZ2 = pos2.z + gap;
    const maxZ2 = pos2.z + dim2.height - gap;

    // Çarpışma Mantığı:
    // Eğer 1'in sağı, 2'nin solundan gerideyse... VEYA 1'in solu, 2'nin sağından ilerideyse... Çarpışma YOKTUR.
    // Bu mantığın tersi: Çarpışma VARDIR.

    const noOverlap =
      maxX1 <= minX2 ||
      minX1 >= maxX2 ||
      maxY1 <= minY2 ||
      minY1 >= maxY2 ||
      maxZ1 <= minZ2 ||
      minZ1 >= maxZ2;

    return !noOverlap;
  }

  /**
   * Bir kutunun Konteyner sınırları içinde olup olmadığını kontrol eder.
   */
  static isInsideContainer(
    pos: Vector3,
    dim: Dimensions,
    containerDim: Dimensions
  ): boolean {
    return (
      pos.x >= 0 &&
      pos.x + dim.width <= containerDim.width &&
      pos.y >= 0 &&
      pos.y + dim.length <= containerDim.length &&
      pos.z >= 0 &&
      pos.z + dim.height <= containerDim.height
    );
  }
}
