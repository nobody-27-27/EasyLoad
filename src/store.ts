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

interface AppState {
  container: Container;
  cargoList: CargoItem[];
  resultItems: PlacedItem[];
  isCalculating: boolean;

  // --- YENİ EKLENEN İSTATİSTİKLER ---
  stats: {
    totalVolume: number; // Konteyner Hacmi (m3)
    usedVolume: number; // Yüklerin Hacmi (m3)
    fillRate: number; // Doluluk Oranı (%)
    placedCount: number; // Yerleşen Adet
    totalCount: number; // Toplam Adet
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
  isCalculating: false,

  // Başlangıç istatistikleri (Boş)
  stats: {
    totalVolume: 0,
    usedVolume: 0,
    fillRate: 0,
    placedCount: 0,
    totalCount: 0,
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
        const results = solver.solve(cargoList);

        // --- İSTATİSTİK HESAPLAMA ---
        // 1. Konteyner Hacmi (cm3 -> m3 dönüşümü için 1.000.000'a bölüyoruz)
        const contVol =
          (container.dimensions.width *
            container.dimensions.length *
            container.dimensions.height) /
          1_000_000;

        // 2. Yüklenenlerin Hacmi
        let usedVol = 0;
        results.forEach((item) => {
          usedVol +=
            item.dimensions.width *
            item.dimensions.length *
            item.dimensions.height;
        });
        usedVol = usedVol / 1_000_000; // m3

        // 3. Doluluk Oranı
        const rate = (usedVol / contVol) * 100;

        // 4. Toplam Adet (Miktar bazlı)
        const totalQty = cargoList.reduce(
          (acc, item) => acc + item.quantity,
          0
        );

        set({
          resultItems: results,
          isCalculating: false,
          stats: {
            totalVolume: Number(contVol.toFixed(2)),
            usedVolume: Number(usedVol.toFixed(2)),
            fillRate: Number(rate.toFixed(2)),
            placedCount: results.length,
            totalCount: totalQty,
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
      stats: {
        totalVolume: 0,
        usedVolume: 0,
        fillRate: 0,
        placedCount: 0,
        totalCount: 0,
      },
      isCalculating: false,
    });

    // Kullanıcıya bilgi ver (Opsiyonel)
    alert("Proje başarıyla yüklendi! Lütfen tekrar 'HESAPLA' butonuna basın.");
  },

  reset: () => set({ cargoList: [], resultItems: [] }),
}));
