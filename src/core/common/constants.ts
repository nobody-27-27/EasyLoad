// src/core/common/constants.ts
import type { Container, Dimensions } from './types';

// Standart Konteyner Ölçüleri (cm cinsinden yaklaşık iç ölçüler)
export const CONTAINER_PRESETS: Record<string, Container> = {
  TRUCK: {
    name: 'Standard Truck',
    type: 'Truck',
    dimensions: { width: 245, length: 1360, height: 260 },
  },
  '40HC': {
    name: '40ft High Cube',
    type: '40HC',
    dimensions: { width: 235, length: 1203, height: 269 },
  },
  '40DC': {
    name: '40ft Standard',
    type: '40DC',
    dimensions: { width: 235, length: 1203, height: 239 },
  },
  '20DC': {
    name: '20ft Standard',
    type: '20DC',
    dimensions: { width: 235, length: 589, height: 239 },
  },
};

// Varsayılan Palet (Euro Pallet)
export const DEFAULT_PALLET: Dimensions = {
  width: 80,
  length: 120,
  height: 15, // Palet tahta yüksekliği
};
