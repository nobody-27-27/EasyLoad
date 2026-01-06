// src/core/common/types.ts

export interface Dimensions {
  width: number;
  length: number;
  height: number;
}

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export type CargoType = 'box' | 'cylinder' | 'pallet';

export interface CargoItem {
  id: string;
  name: string;
  type: CargoType;
  quantity: number;
  color: string;
  dimensions: Dimensions;
  weight?: number;
  stackable: boolean;
  maxStackWeight?: number;
  allowedRotation: {
    x: boolean;
    y: boolean;
    z: boolean;
  };
}

export interface PlacedItem extends CargoItem {
  position: Vector3;
  rotation: Vector3;
  // ADDED: Center point for accurate 3D positioning
  center?: Vector3;
  uniqueId: string;
  layerId?: number;
}

export interface Container {
  name: string;
  type: 'Truck' | '40HC' | '40DC' | '20DC' | 'Custom';
  dimensions: Dimensions;
  maxWeight?: number;
}