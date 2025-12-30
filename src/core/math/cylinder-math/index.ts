// src/core/math/cylinder-math/index.ts

/**
 * Cylinder Math Module
 *
 * Pure mathematical utilities for cylinder geometry calculations.
 * These functions have no side effects and are suitable for unit testing.
 */

export { HoneycombMath } from './honeycomb';

export {
  CylinderGeometry,
  type Circle2D,
  type Cylinder3D,
  type CylinderOrientation,
  type ValleyPosition,
  type CylinderBoundingBox,
} from './cylinder-geometry';
