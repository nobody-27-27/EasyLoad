// src/core/common/types.ts

/**
 * 3D dimensions in centimeters.
 */
export interface Dimensions {
  width: number;  // X axis
  length: number; // Y axis (depth)
  height: number; // Z axis
}

/**
 * 3D vector / point.
 */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Cargo types supported by the system.
 */
export type CargoType = 'box' | 'cylinder' | 'pallet';

/**
 * Raw cargo item as entered by the user.
 */
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

/**
 * A placed item with position and rotation in container space.
 */
export interface PlacedItem extends CargoItem {
  position: Vector3;
  rotation: Vector3;
  uniqueId: string;
  layerId?: number;
}

/**
 * Container type identifiers.
 */
export type ContainerType = 'Truck' | '40HC' | '40DC' | '20DC' | 'Custom';

/**
 * Container / vehicle definition.
 */
export interface Container {
  name: string;
  type: ContainerType;
  dimensions: Dimensions;
  maxWeight?: number;
}

/**
 * Summary of items that could not be placed.
 */
export interface UnplacedSummary {
  name: string;
  count: number;
}

/**
 * Loading statistics after calculation.
 */
export interface LoadingStats {
  totalVolume: number;
  usedVolume: number;
  fillRate: number;
  placedCount: number;
  totalCount: number;
  unplacedCount: number;
}
