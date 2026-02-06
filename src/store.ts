// src/store.ts
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type {
  Container,
  CargoItem,
  PlacedItem,
  Dimensions,
  LoadingStats,
  UnplacedSummary,
} from './core/common/types';
import { CONTAINER_PRESETS } from './core/common/constants';
import { MixedSolver } from './core/solvers/mixed-solver/orchestrator';
import { calculateStats, EMPTY_STATS } from './core/common/statistics';
import { showToast } from './components/Toast';

export interface AppState {
  container: Container;
  cargoList: CargoItem[];
  resultItems: PlacedItem[];
  unplacedSummary: UnplacedSummary[];
  isCalculating: boolean;
  stats: LoadingStats;

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
  stats: EMPTY_STATS,

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
        const { stats, unplacedSummary } = calculateStats(container, cargoList, placedItems);

        set({
          resultItems: placedItems,
          unplacedSummary,
          isCalculating: false,
          stats,
        });
      } catch (e) {
        console.error(e);
        set({ isCalculating: false });
        showToast('Hesaplama Hatasi!', 'error');
      }
    }, 100);
  },

  loadProject: (data) => {
    set({
      container: data.container || CONTAINER_PRESETS['TRUCK'],
      cargoList: data.cargoList || [],
      resultItems: [],
      unplacedSummary: [],
      stats: EMPTY_STATS,
      isCalculating: false,
    });
  },

  reset: () =>
    set({
      cargoList: [],
      resultItems: [],
      unplacedSummary: [],
      stats: EMPTY_STATS,
    }),
}));
