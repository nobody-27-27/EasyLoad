// src/core/solvers/coil-solver/types.ts

import type { CargoItem, Vector3 } from '../../common/types';
import type { CylinderOrientation } from '../../math/cylinder-math/cylinder-geometry';

/**
 * A cylinder with resolved orientation and placement info.
 * Used internally during solving.
 */
export interface ResolvedCylinder {
  item: CargoItem;
  radius: number;
  length: number;
  orientation: CylinderOrientation;
}

/**
 * Represents a placed cylinder with all necessary info
 */
export interface PlacedCylinder {
  item: CargoItem;
  uniqueId: string;
  position: Vector3; // Corner position (bottom-left-back)
  center: Vector3; // Center position for geometric calculations
  radius: number;
  length: number;
  orientation: CylinderOrientation;
  rotation: Vector3; // Rotation angles for Three.js rendering
  layerId: number;
  supportedBy: string[]; // IDs of supporting cylinders (for stability)
}

/**
 * A candidate position for placing a cylinder
 */
export interface PlacementCandidate {
  position: Vector3; // Corner position
  center: Vector3; // Center position
  orientation: CylinderOrientation;
  score: number;
  supportType: SupportType;
  supportingIds: string[];
}

/**
 * Types of support for cylinder placement
 */
export type SupportType =
  | 'floor' // Resting on container floor
  | 'stacked' // Directly on top of another cylinder
  | 'nested' // In a valley between two cylinders
  | 'mixed-support'; // On top of cylinders with different orientations

/**
 * A layer of cylinders (used for systematic stacking)
 */
export interface CylinderLayer {
  id: number;
  baseZ: number; // Z coordinate of layer bottom
  height: number; // Height of this layer
  orientation: CylinderOrientation;
  cylinders: PlacedCylinder[];
}

/**
 * Configuration for the solver
 */
export interface CoilSolverConfig {
  // Safety margins
  wallMargin: number; // Distance from container walls
  cylinderMargin: number; // Gap between cylinders

  // Optimization weights
  depthWeight: number; // Weight for filling depth (Y) first
  heightWeight: number; // Weight for filling bottom layers first
  widthWeight: number; // Weight for filling left-to-right

  // Strategy settings
  preferVertical: boolean; // Prefer vertical orientation when both are valid
  enableMixedLayers: boolean; // Allow different orientations in same Y-slice
  maxLayersPerStack: number; // Maximum vertical stacking layers

  // Physics
  maxStackingRatio: number; // Max height/diameter ratio for stability
}

/**
 * Default solver configuration
 */
export const DEFAULT_COIL_SOLVER_CONFIG: CoilSolverConfig = {
  wallMargin: 0.5, // 5mm from walls
  cylinderMargin: 0.1, // 1mm between cylinders

  depthWeight: 100000,
  heightWeight: 1000,
  widthWeight: 1,

  preferVertical: false, // Horizontal is often more space-efficient
  enableMixedLayers: true,
  maxLayersPerStack: 10,

  maxStackingRatio: 3.0, // Height can be 3x the diameter for stability
};

/**
 * Result of solving a coil packing problem
 */
export interface CoilSolverResult {
  placedCylinders: PlacedCylinder[];
  unplacedItems: CargoItem[];
  statistics: PackingStatistics;
}

/**
 * Statistics about the packing result
 */
export interface PackingStatistics {
  totalVolumePlaced: number;
  containerVolumeUsed: number; // Including wasted space in bounding region
  volumeEfficiency: number; // totalVolumePlaced / containerVolumeUsed
  layerCount: number;
  itemsPlaced: number;
  itemsFailed: number;
}

/**
 * Rotation angles for each orientation (in radians)
 */
export const ORIENTATION_ROTATIONS: Record<CylinderOrientation, Vector3> = {
  vertical: { x: 0, y: 0, z: 0 },
  'horizontal-x': { x: 0, y: 0, z: Math.PI / 2 },
  'horizontal-y': { x: Math.PI / 2, y: 0, z: 0 },
};

/**
 * Get dimensions in container space for a given orientation
 */
export function getOrientedDimensions(
  diameter: number,
  length: number,
  orientation: CylinderOrientation
): { x: number; y: number; z: number } {
  switch (orientation) {
    case 'vertical':
      return { x: diameter, y: diameter, z: length };
    case 'horizontal-x':
      return { x: length, y: diameter, z: diameter };
    case 'horizontal-y':
      return { x: diameter, y: length, z: diameter };
  }
}

/**
 * Get allowed orientations for a cargo item based on its constraints
 */
export function getAllowedOrientations(item: CargoItem): CylinderOrientation[] {
  const orientations: CylinderOrientation[] = [];

  // Vertical is always allowed unless x-rotation (tipping) is required
  if (!item.allowedRotation.x || item.allowedRotation.x) {
    orientations.push('vertical');
  }

  // Horizontal-Y (laying along depth) requires x-rotation
  if (item.allowedRotation.x) {
    orientations.push('horizontal-y');
  }

  // Horizontal-X (laying along width) requires z-rotation
  if (item.allowedRotation.z) {
    orientations.push('horizontal-x');
  }

  // If nothing is explicitly allowed, default to vertical
  if (orientations.length === 0) {
    orientations.push('vertical');
  }

  return orientations;
}
