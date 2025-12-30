// src/store.ts
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  Container,
  CargoItem,
  PlacedItem,
  Dimensions,
} from './core/common/types';
import { CONTAINER_PRESETS } from './core/common/constants';
import { MixedSolver } from './core/solvers/mixed-solver/orchestrator';

interface UnplacedSummary {
  name: string;
  count: number;
}

interface AppState {
  container: Container;
  cargoList: CargoItem[];
  resultItems: PlacedItem[];
  unplacedSummary: UnplacedSummary[];
  isCalculating: boolean;

  // --- YENİ EKLENEN İSTATİSTİKLER ---
  stats: {
    totalVolume: number; // Konteyner Hacmi (m3)
    usedVolume: number; // Yüklerin Hacmi (m3)
    fillRate: number; // Doluluk Oranı (%)
    placedCount: number; // Yerleşen Adet
    totalCount: number; // Toplam Adet
    unplacedCount: number; // Yerleşmeyen Adet
  };

  setContainer: (type: string, customDims?: Dimensions) => void;
  addCargo: (item: Omit<CargoItem, 'id'>) => void;
  removeCargo: (id: string) => void;
  runCalculation: () => void;
  reset: () => void;
  loadProject: (data: Partial<AppState>) => void;
}

export const useStore = create<AppState>((set, get) => ({
  container: CONTAINER_PRESETS['TRUCK'],
  cargoList: [],
  resultItems: [],
  unplacedSummary: [],
  isCalculating: false,

  // Başlangıç istatistikleri (Boş)
  stats: {
    totalVolume: 0,
    usedVolume: 0,
    fillRate: 0,
    placedCount: 0,
    totalCount: 0,
    unplacedCount: 0,
  },

  setContainer: (type, customDims) => {
    let newContainer = { ...CONTAINER_PRESETS['TRUCK'] };
    if (CONTAINER_PRESETS[type]) {
      newContainer = { ...CONTAINER_PRESETS[type] };
    } else if (type === 'Custom' && customDims) {
      newContainer = { name: 'Custom', type: 'Custom', dimensions: customDims };
    }
    set({
      container: newContainer,
      resultItems: [],
      stats: { ...get().stats, fillRate: 0 },
    });
  },

  addCargo: (itemData) => {
    const newItem: CargoItem = { ...itemData, id: uuidv4() };
    set((state) => ({
      cargoList: [...state.cargoList, newItem],
      resultItems: [],
    }));
  },

  removeCargo: (id) => {
    set((state) => ({
      cargoList: state.cargoList.filter((i) => i.id !== id),
      resultItems: [],
    }));
  },

  runCalculation: () => {
    const { container, cargoList } = get();
    if (cargoList.length === 0) return;

    set({ isCalculating: true });

    setTimeout(() => {
      try {
        const solver = new MixedSolver(container);
        const { placedItems } = solver.solveWithReport(cargoList);

        // --- İSTATİSTİK HESAPLAMA ---
        // 1. Konteyner Hacmi (cm3 -> m3 dönüşümü için 1.000.000'a bölüyoruz)
        const contVol =
          (container.dimensions.width *
            container.dimensions.length *
            container.dimensions.height) /
          1_000_000;

        // 2. Yüklenenlerin Hacmi
        let usedVol = 0;
        placedItems.forEach((item) => {
          if (item.type === 'cylinder') {
            // Silindir hacmi: π * r² * h
            const r = item.dimensions.width / 2;
            usedVol += Math.PI * r * r * item.dimensions.height;
          } else {
            usedVol +=
              item.dimensions.width *
              item.dimensions.length *
              item.dimensions.height;
          }
        });
        usedVol = usedVol / 1_000_000; // m3

        // 3. Doluluk Oranı
        const rate = (usedVol / contVol) * 100;

        // 4. Toplam Adet (Miktar bazlı)
        const totalQty = cargoList.reduce(
          (acc, item) => acc + item.quantity,
          0
        );

        // 5. Yerleşmeyen yükleri grupla
        const unplacedMap = new Map<string, number>();
        const unplacedCount = totalQty - placedItems.length;

        // CargoList'ten yerleşmeyenleri bul
        const placedByName = new Map<string, number>();
        placedItems.forEach((item) => {
          const key = item.name;
          placedByName.set(key, (placedByName.get(key) || 0) + 1);
        });

        cargoList.forEach((cargo) => {
          const placedOfThis = placedByName.get(cargo.name) || 0;
          const unplacedOfThis = cargo.quantity - placedOfThis;
          if (unplacedOfThis > 0) {
            unplacedMap.set(cargo.name, unplacedOfThis);
          }
          // Adjust for next same-named cargo
          if (placedOfThis > 0) {
            placedByName.set(cargo.name, Math.max(0, placedOfThis - cargo.quantity));
          }
        });

        const unplacedSummary = Array.from(unplacedMap.entries()).map(([name, count]) => ({
          name,
          count,
        }));

        set({
          resultItems: placedItems,
          unplacedSummary,
          isCalculating: false,
          stats: {
            totalVolume: Number(contVol.toFixed(2)),
            usedVolume: Number(usedVol.toFixed(2)),
            fillRate: Number(rate.toFixed(2)),
            placedCount: placedItems.length,
            totalCount: totalQty,
            unplacedCount,
          },
        });
      } catch (e) {
        console.error(e);
        set({ isCalculating: false });
        alert('Hesaplama Hatası!');
      }
    }, 100);
  },

  loadProject: (data) => {
    // Gelen veriyi store'a yaz
    set({
      container: data.container || CONTAINER_PRESETS['TRUCK'],
      cargoList: data.cargoList || [],
      // Sonuçları ve istatistikleri sıfırla ki tekrar hesaplansın (veya onları da yükleyebilirsin)
      resultItems: [],
      unplacedSummary: [],
      stats: {
        totalVolume: 0,
        usedVolume: 0,
        fillRate: 0,
        placedCount: 0,
        totalCount: 0,
        unplacedCount: 0,
      },
      isCalculating: false,
    });

    // Toast notification will be shown by the component
  },

  reset: () => set({ cargoList: [], resultItems: [] }),
}));
