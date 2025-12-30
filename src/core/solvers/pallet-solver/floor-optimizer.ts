// src/core/solvers/pallet-solver/floor-optimizer.ts

import type { Container, CargoItem, PlacedItem } from '../../common/types';
import { GuillotinePacker } from '../../math/pallet-math/guillotine';

interface OptimizerOptions {
  gap: number; // Palet arası boşluk toleransı (cm)
}

export class FloorOptimizer {
  private container: Container;
  private options: OptimizerOptions;

  constructor(container: Container, options: OptimizerOptions = { gap: 0 }) {
    this.container = container;
    this.options = options;
  }

  public solve(items: CargoItem[]): PlacedItem[] {
    const placedItems: PlacedItem[] = [];

    // Konteyner zeminini yöneten matematik motorunu başlat
    const packer = new GuillotinePacker(
      this.container.dimensions.width,
      this.container.dimensions.length
    );

    // Paletleri "Taban Alanına" (Width x Length) göre büyükten küçüğe sırala.
    // Büyük parçaları önce yerleştirmek her zaman daha verimlidir.
    const sortedItems = [...items].sort((a, b) => {
      const areaA = a.dimensions.width * a.dimensions.length;
      const areaB = b.dimensions.width * b.dimensions.length;
      return areaB - areaA;
    });

    const gap = this.options.gap;

    for (const item of sortedItems) {
      // 1. Paletin efektif boyutu (Tolerans dahil)
      // Eğer gap=2cm ise, palet 80x120 olsa bile 82x122 yer kaplar.
      let effectiveW = item.dimensions.width + gap;
      let effectiveL = item.dimensions.length + gap;

      // 2. Pozisyon Ara (Normal Duruş)
      let fit = packer.findPosition(effectiveW, effectiveL);
      let isRotated = false;

      // 3. Bulamazsa ve Döndürmeye izin varsa Döndürüp Ara
      if (!fit && item.allowedRotation.y) {
        // En ve Boy yer değiştir
        const rotatedW = effectiveL;
        const rotatedL = effectiveW;

        fit = packer.findPosition(rotatedW, rotatedL);
        if (fit) {
          isRotated = true;
          // Yerleştiği için efektif boyutları güncelle
          effectiveW = rotatedW;
          effectiveL = rotatedL;
        }
      }

      // 4. Yerleştirme İşlemi
      if (fit) {
        // Matematik motoruna alanı böldür
        packer.splitFreeRect(fit.index, effectiveW, effectiveL);

        // Görsel yerleşim verisini oluştur
        // Not: Gap, boşluk demektir. Palet, hesaplanan alanın tam ortasına veya köşesine konur.
        // Burada sol-alt köşeye yaslıyoruz, gap kadar boşluk otomatik olarak sağda ve üstte kalıyor.

        placedItems.push({
          ...item,
          uniqueId: `${item.id}_pallet_${placedItems.length}`,
          position: {
            x: fit.x + gap / 2, // Gap'i iki yana eşit dağıtmak için
            y: fit.y + gap / 2,
            z: 0, // Zemin
          },
          rotation: {
            x: 0,
            y: isRotated ? Math.PI / 2 : 0,
            z: 0,
          },
          dimensions: isRotated
            ? {
                ...item.dimensions,
                width: item.dimensions.length,
                length: item.dimensions.width,
              }
            : item.dimensions,
        });
      }
    }

    return placedItems;
  }
}
