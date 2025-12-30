// src/core/solvers/mixed-solver/orchestrator.ts

import type { Container, CargoItem, PlacedItem } from '../../common/types';
import { WallBuilder } from '../box-solver/wall-builder';
import { HoneycombLayerBuilder } from '../coil-solver/honeycomb-layer';

export class MixedSolver {
  private container: Container;

  constructor(container: Container) {
    this.container = container;
  }

  public solve(items: CargoItem[]): PlacedItem[] {
    const placedItems: PlacedItem[] = [];

    // 1. Ayrıştırma
    const coils: CargoItem[] = [];
    const boxes: CargoItem[] = [];

    items.forEach((item) => {
      if (item.type === 'cylinder') {
        coils.push(item);
      } else {
        boxes.push(item);
      }
    });

    // 2. RULOLAR (BRUTE FORCE YERLEŞİM)
    if (coils.length > 0) {
      // SIRALAMA: Hacimsel (Büyükten küçüğe)
      // Bu, "Best Fit Decreasing" stratejisidir. En zor parçalar önce yerleşir.
      coils.sort((a, b) => {
        const volA =
          a.dimensions.width * a.dimensions.width * a.dimensions.height;
        const volB =
          b.dimensions.width * b.dimensions.width * b.dimensions.height;
        // Hacimler çok yakınsa boya bak (Uzunlar önce)
        if (Math.abs(volA - volB) < 1000) {
          return b.dimensions.height - a.dimensions.height;
        }
        return volB - volA;
      });

      const coilSolver = new HoneycombLayerBuilder(this.container);
      // Tüm ürünleri tek bir havuza atıyoruz
      const coilResults = coilSolver.solveEverything(coils);
      placedItems.push(...coilResults);
    }

    // 3. KOLİLER (Kalan Boşluğa)
    // Ruloların bittiği en uç Y noktasını bul
    let maxUsedY = 0;
    placedItems.forEach((item) => {
      // Yerleşen parçanın Y eksenindeki sınırını hesapla
      let ySize = item.dimensions.width; // Varsayılan: Dik duruş (Y=Çap)

      // Eğer Yatık (X=90) ise Y=Boy
      if (Math.abs(item.rotation.x) > 0.1) ySize = item.dimensions.height;
      // Eğer Yan (Z=90) ise Y=Çap

      if (item.position.y + ySize > maxUsedY)
        maxUsedY = item.position.y + ySize;
    });

    if (boxes.length > 0) {
      const remainingLength = this.container.dimensions.length - maxUsedY;
      if (remainingLength > 1) {
        const virtualContainer: Container = {
          ...this.container,
          dimensions: { ...this.container.dimensions, length: remainingLength },
        };
        const boxSolver = new WallBuilder(virtualContainer, boxes);
        const boxResults = boxSolver.solve();

        boxResults.forEach((item) => {
          item.position.y += maxUsedY;
          placedItems.push(item);
        });
      }
    }

    return placedItems;
  }
}
