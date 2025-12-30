// src/core/solvers/coil-solver/index.ts

/**
 * Coil Solver Module
 *
 * A comprehensive 3D cylinder/coil packing solution that supports:
 * - Vertical stacking (column generation - like coins)
 * - Horizontal stacking (honeycomb packing - like logs)
 * - Mixed orientation strategies
 * - Valley/nesting optimization for space efficiency
 *
 * Architecture:
 * - CoilSolver: Main orchestrator
 * - VerticalStacker: Handles upright cylinder placement
 * - HorizontalStacker: Handles lying cylinder placement
 * - ValleyManager: Manages 3D pocket detection between cylinders
 * - CylinderGeometry: Pure math utilities for cylinder calculations
 */

// Main solver
export { CoilSolver, type OrientationStrategy } from './coil-solver';

// Sub-solvers
export { VerticalStacker } from './vertical-stacker';
export { HorizontalStacker } from './horizontal-stacker';

// Managers
export { ValleyManager } from './valley-manager';

// Types
export type {
  PlacedCylinder,
  PlacementCandidate,
  ResolvedCylinder,
  CylinderLayer,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
  SupportType,
} from './types';

export {
  DEFAULT_COIL_SOLVER_CONFIG,
  ORIENTATION_ROTATIONS,
  getOrientedDimensions,
  getAllowedOrientations,
} from './types';

// Legacy export for backwards compatibility
export { HoneycombLayerBuilder } from './honeycomb-layer';
