// src/core/math/cylinder-math/cylinder-geometry.ts

/**
 * 3D Cylinder Geometry Utilities
 * Pure mathematical functions for cylinder positioning and collision detection.
 *
 * Coordinate System:
 * - X: Width (left-right)
 * - Y: Depth (front-back)
 * - Z: Height (bottom-top)
 */

export interface Circle2D {
  x: number;
  z: number;
  radius: number;
}

export interface Cylinder3D {
  center: { x: number; y: number; z: number };
  radius: number;
  length: number;
  orientation: CylinderOrientation;
}

export type CylinderOrientation = 'vertical' | 'horizontal-x' | 'horizontal-y';

/**
 * Result of a valley/pocket detection
 */
export interface ValleyPosition {
  x: number;
  z: number;
  supportingCircles: [Circle2D, Circle2D];
  maxRadiusThatFits: number;
}

/**
 * Bounding box for a cylinder in 3D space
 */
export interface CylinderBoundingBox {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

const EPSILON = 0.001; // 1mm tolerance

export class CylinderGeometry {
  /**
   * Calculate the 2D distance between two circle centers (in XZ plane)
   */
  static distance2D(c1: { x: number; z: number }, c2: { x: number; z: number }): number {
    const dx = c2.x - c1.x;
    const dz = c2.z - c1.z;
    return Math.sqrt(dx * dx + dz * dz);
  }

  /**
   * Calculate 3D distance between two points
   */
  static distance3D(
    p1: { x: number; y: number; z: number },
    p2: { x: number; y: number; z: number }
  ): number {
    const dx = p2.x - p1.x;
    const dy = p2.y - p1.y;
    const dz = p2.z - p1.z;
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Check if two circles overlap in the XZ plane
   */
  static circlesOverlap(c1: Circle2D, c2: Circle2D, margin: number = 0): boolean {
    const dist = this.distance2D(c1, c2);
    return dist < c1.radius + c2.radius - margin;
  }

  /**
   * Check if a circle is tangent to another (touching but not overlapping)
   */
  static circlesTangent(c1: Circle2D, c2: Circle2D, tolerance: number = EPSILON): boolean {
    const dist = this.distance2D(c1, c2);
    const expectedDist = c1.radius + c2.radius;
    return Math.abs(dist - expectedDist) < tolerance;
  }

  /**
   * Calculate where a new circle can nestle between two existing circles
   * This is the "valley" or "pocket" position calculation.
   *
   * Uses the geometric principle that the centers form a triangle where:
   * - Side a = r1 + r3 (distance from c1 to new circle)
   * - Side b = r2 + r3 (distance from c2 to new circle)
   * - Side c = distance between c1 and c2
   */
  static calculateNestPosition(
    c1: Circle2D,
    c2: Circle2D,
    newRadius: number
  ): { x: number; z: number } | null {
    const dist = this.distance2D(c1, c2);

    // Check if circles are too far apart to support a new circle
    const maxSupportDistance = c1.radius + c2.radius + 2 * newRadius;
    if (dist > maxSupportDistance) {
      return null;
    }

    // Check if circles are overlapping (invalid state)
    if (dist < Math.abs(c1.radius - c2.radius) + EPSILON) {
      return null;
    }

    // Triangle side lengths
    const a = c1.radius + newRadius;
    const b = c2.radius + newRadius;
    const c = dist;

    // Using projection formula: x_local = (a² - b² + c²) / (2c)
    const projection = (a * a - b * b + c * c) / (2 * c);

    // Height using Pythagorean theorem
    const heightSquared = a * a - projection * projection;
    if (heightSquared < 0) {
      return null;
    }
    const height = Math.sqrt(heightSquared);

    // Unit vector from c1 to c2
    const dx = c2.x - c1.x;
    const dz = c2.z - c1.z;
    const ux = dx / c;
    const uz = dz / c;

    // Normal vector (perpendicular, pointing "up" in XZ plane)
    // We want the one that gives us the higher Z value
    const nx = -uz;
    const nz = ux;

    // Calculate both possible positions (above and below the line)
    const pos1 = {
      x: c1.x + ux * projection + nx * height,
      z: c1.z + uz * projection + nz * height,
    };
    const pos2 = {
      x: c1.x + ux * projection - nx * height,
      z: c1.z + uz * projection - nz * height,
    };

    // Return the position with higher Z (the one that sits ON TOP of the support circles)
    return pos1.z > pos2.z ? pos1 : pos2;
  }

  /**
   * Calculate the maximum radius that can fit in a valley between two circles
   */
  static maxRadiusInValley(c1: Circle2D, c2: Circle2D): number {
    const dist = this.distance2D(c1, c2);

    // If circles are touching or overlapping, no room for another circle
    if (dist <= c1.radius + c2.radius + EPSILON) {
      return 0;
    }

    // Binary search for maximum radius
    let low = 0;
    let high = Math.min(c1.radius, c2.radius, (dist - c1.radius - c2.radius) / 2);

    while (high - low > EPSILON) {
      const mid = (low + high) / 2;
      const pos = this.calculateNestPosition(c1, c2, mid);
      if (pos !== null) {
        low = mid;
      } else {
        high = mid;
      }
    }

    return low;
  }

  /**
   * Calculate the bounding box for a cylinder given its position and orientation
   */
  static getBoundingBox(
    center: { x: number; y: number; z: number },
    radius: number,
    length: number,
    orientation: CylinderOrientation
  ): CylinderBoundingBox {
    switch (orientation) {
      case 'vertical':
        // Cylinder standing upright (axis along Z)
        return {
          minX: center.x - radius,
          maxX: center.x + radius,
          minY: center.y - radius,
          maxY: center.y + radius,
          minZ: center.z,
          maxZ: center.z + length,
        };
      case 'horizontal-x':
        // Cylinder lying along X axis
        return {
          minX: center.x - length / 2,
          maxX: center.x + length / 2,
          minY: center.y - radius,
          maxY: center.y + radius,
          minZ: center.z,
          maxZ: center.z + 2 * radius,
        };
      case 'horizontal-y':
        // Cylinder lying along Y axis (depth)
        return {
          minX: center.x - radius,
          maxX: center.x + radius,
          minY: center.y - length / 2,
          maxY: center.y + length / 2,
          minZ: center.z,
          maxZ: center.z + 2 * radius,
        };
    }
  }

  /**
   * Convert cylinder corner position (used in PlacedItem) to center position
   */
  static cornerToCenter(
    cornerPos: { x: number; y: number; z: number },
    radius: number,
    length: number,
    orientation: CylinderOrientation
  ): { x: number; y: number; z: number } {
    switch (orientation) {
      case 'vertical':
        return {
          x: cornerPos.x + radius,
          y: cornerPos.y + radius,
          z: cornerPos.z,
        };
      case 'horizontal-x':
        return {
          x: cornerPos.x + length / 2,
          y: cornerPos.y + radius,
          z: cornerPos.z,
        };
      case 'horizontal-y':
        return {
          x: cornerPos.x + radius,
          y: cornerPos.y + length / 2,
          z: cornerPos.z,
        };
    }
  }

  /**
   * Convert cylinder center position to corner position (for PlacedItem)
   */
  static centerToCorner(
    centerPos: { x: number; y: number; z: number },
    radius: number,
    length: number,
    orientation: CylinderOrientation
  ): { x: number; y: number; z: number } {
    switch (orientation) {
      case 'vertical':
        return {
          x: centerPos.x - radius,
          y: centerPos.y - radius,
          z: centerPos.z,
        };
      case 'horizontal-x':
        return {
          x: centerPos.x - length / 2,
          y: centerPos.y - radius,
          z: centerPos.z,
        };
      case 'horizontal-y':
        return {
          x: centerPos.x - radius,
          y: centerPos.y - length / 2,
          z: centerPos.z,
        };
    }
  }

  /**
   * Check if two cylinders collide in 3D space
   * This handles the actual cylindrical geometry, not just bounding boxes.
   */
  static cylindersCollide(cyl1: Cylinder3D, cyl2: Cylinder3D, margin: number = 0): boolean {
    // First, quick AABB check
    const bb1 = this.getBoundingBox(cyl1.center, cyl1.radius, cyl1.length, cyl1.orientation);
    const bb2 = this.getBoundingBox(cyl2.center, cyl2.radius, cyl2.length, cyl2.orientation);

    if (!this.aabbOverlap(bb1, bb2, margin)) {
      return false;
    }

    // For same-orientation cylinders, we can use simpler checks
    if (cyl1.orientation === cyl2.orientation) {
      return this.sameOrientationCollision(cyl1, cyl2, margin);
    }

    // For different orientations, use conservative AABB (already checked above)
    // A full cylinder-cylinder intersection for mixed orientations is complex
    // and the AABB approximation is sufficient for packing purposes
    return true;
  }

  /**
   * AABB overlap check
   */
  private static aabbOverlap(bb1: CylinderBoundingBox, bb2: CylinderBoundingBox, margin: number): boolean {
    return !(
      bb1.maxX <= bb2.minX + margin ||
      bb1.minX >= bb2.maxX - margin ||
      bb1.maxY <= bb2.minY + margin ||
      bb1.minY >= bb2.maxY - margin ||
      bb1.maxZ <= bb2.minZ + margin ||
      bb1.minZ >= bb2.maxZ - margin
    );
  }

  /**
   * Collision check for cylinders with the same orientation
   */
  private static sameOrientationCollision(cyl1: Cylinder3D, cyl2: Cylinder3D, margin: number): boolean {
    switch (cyl1.orientation) {
      case 'vertical': {
        // Check if they overlap in Z (height) range
        const zOverlap = !(
          cyl1.center.z + cyl1.length <= cyl2.center.z + margin ||
          cyl1.center.z >= cyl2.center.z + cyl2.length - margin
        );
        if (!zOverlap) return false;

        // Check XY plane circle overlap
        const dist = Math.sqrt(
          Math.pow(cyl1.center.x - cyl2.center.x, 2) +
          Math.pow(cyl1.center.y - cyl2.center.y, 2)
        );
        return dist < cyl1.radius + cyl2.radius - margin;
      }

      case 'horizontal-x': {
        // Check if they overlap in X range
        const xOverlap = !(
          cyl1.center.x + cyl1.length / 2 <= cyl2.center.x - cyl2.length / 2 + margin ||
          cyl1.center.x - cyl1.length / 2 >= cyl2.center.x + cyl2.length / 2 - margin
        );
        if (!xOverlap) return false;

        // Check YZ plane circle overlap
        const dist = Math.sqrt(
          Math.pow(cyl1.center.y - cyl2.center.y, 2) +
          Math.pow(cyl1.center.z + cyl1.radius - (cyl2.center.z + cyl2.radius), 2)
        );
        return dist < cyl1.radius + cyl2.radius - margin;
      }

      case 'horizontal-y': {
        // Check if they overlap in Y range
        const yOverlap = !(
          cyl1.center.y + cyl1.length / 2 <= cyl2.center.y - cyl2.length / 2 + margin ||
          cyl1.center.y - cyl1.length / 2 >= cyl2.center.y + cyl2.length / 2 - margin
        );
        if (!yOverlap) return false;

        // Check XZ plane circle overlap
        const dist = Math.sqrt(
          Math.pow(cyl1.center.x - cyl2.center.x, 2) +
          Math.pow(cyl1.center.z + cyl1.radius - (cyl2.center.z + cyl2.radius), 2)
        );
        return dist < cyl1.radius + cyl2.radius - margin;
      }
    }
  }

  /**
   * Calculate the floor height where a cylinder would rest on two supporting circles
   * Returns the Z coordinate of the bottom of the new cylinder
   */
  static calculateRestingHeight(
    support1: Circle2D,
    support2: Circle2D,
    newRadius: number
  ): number | null {
    const nestPos = this.calculateNestPosition(support1, support2, newRadius);
    if (!nestPos) return null;

    // The nest position gives us the center of the circle
    // The bottom of the cylinder is at z - radius (for horizontal) or z (for vertical)
    return nestPos.z - newRadius;
  }

  /**
   * Calculate the Z coordinate of a cylinder resting on the floor
   */
  static getFloorRestingZ(_orientation: CylinderOrientation): number {
    // All orientations rest at Z=0 on the floor
    return 0;
  }

  /**
   * Calculate the Z coordinate of a cylinder resting on top of another cylinder
   */
  static getStackingZ(
    baseZ: number,
    baseRadius: number,
    baseLength: number,
    baseOrientation: CylinderOrientation,
    _newRadius: number,
    _newOrientation: CylinderOrientation
  ): number {
    // Height of top of base cylinder
    let baseTop: number;
    if (baseOrientation === 'vertical') {
      baseTop = baseZ + baseLength;
    } else {
      baseTop = baseZ + 2 * baseRadius;
    }

    return baseTop;
  }
}
