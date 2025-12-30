// src/core/solvers/mixed-solver/volume-manager.ts

import type {
  Container,
  PlacedItem,
  Dimensions,
  Vector3,
} from '../../common/types';

/**
 * Sanal Hacim (Virtual Volume)
 * Konteynerin içinde, içine yükleme yapılabilecek alt bölge.
 */
export interface VirtualVolume {
  id: string;
  origin: Vector3; // Bu hacmin global konteynerdeki başlangıç noktası
  dimensions: Dimensions; // Hacmin boyutları
  supported: boolean; // Altı dolu mu? (Zemine mi basıyor yoksa palet üstü mü?)
}

export class VolumeManager {
  /**
   * Paletler yerleştirildikten sonra kalan boşlukları analiz eder.
   */
  static extractVolumes(
    container: Container,
    placedPallets: PlacedItem[]
  ): VirtualVolume[] {
    const volumes: VirtualVolume[] = [];
    const contW = container.dimensions.width;
    const contH = container.dimensions.height;
    const contL = container.dimensions.length;

    // 1. Palet Üstü Hacimler (Top Volumes)
    // Her paletin üstünü ayrı bir hacim olarak tanımla.
    // İleri Versiyon Notu: Yan yana aynı yükseklikteki paletler birleştirilip (Merge)
    // daha büyük tek bir zemin oluşturulabilir. Şimdilik her palet tek başına bir bölge.

    placedPallets.forEach((pallet, index) => {
      // Paletin üstünde kalan yükseklik
      const remainingHeight =
        contH - (pallet.position.z + pallet.dimensions.height);

      // Eğer kayda değer bir boşluk varsa (örn: 10cm'den fazla)
      if (remainingHeight > 10) {
        volumes.push({
          id: `vol_pallet_top_${index}`,
          origin: {
            x: pallet.position.x,
            y: pallet.position.y,
            z: pallet.position.z + pallet.dimensions.height, // Paletin tavanı, yeni hacmin zemini
          },
          dimensions: {
            width: pallet.dimensions.width,
            length: pallet.dimensions.length,
            height: remainingHeight,
          },
          supported: true, // Palet üstü sağlamdır
        });
      }
    });

    // 2. Ön Boşluk (Front Volume)
    // Paletlerin bittiği yerden, tırın kapısına kadar olan boşluk.
    // Bunun için en ileri giden paleti bulmalıyız.
    let maxY = 0;
    placedPallets.forEach((p) => {
      const endY = p.position.y + p.dimensions.length;
      if (endY > maxY) maxY = endY;
    });

    const remainingLength = contL - maxY;

    // Eğer ön tarafta kayda değer boşluk varsa
    if (remainingLength > 10) {
      volumes.push({
        id: 'vol_front_rest',
        origin: { x: 0, y: maxY, z: 0 }, // Zeminden başlar
        dimensions: {
          width: contW,
          length: remainingLength,
          height: contH,
        },
        supported: true, // Tır zemini sağlamdır
      });
    }

    return volumes;
  }
}
