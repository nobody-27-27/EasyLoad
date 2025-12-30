// src/core/solvers/coil-solver/valley-manager.ts

import type { Container } from '../../common/types';
import { CylinderGeometry, type Circle2D } from '../../math/cylinder-math/cylinder-geometry';
import type { PlacedCylinder, PlacementCandidate, CoilSolverConfig } from './types';

/**
 * ValleyManager handles the detection and management of valleys (pockets)
 * between placed cylinders. This is critical for honeycomb-style packing.
 *
 * It maintains a spatial index of placed cylinders and can efficiently
 * find valid nesting positions for new cylinders.
 */
export class ValleyManager {
  private placedCylinders: PlacedCylinder[] = [];
  private container: Container;
  private config: CoilSolverConfig;

  // Spatial partitioning for efficient lookup
  private ySlices: Map<number, PlacedCylinder[]> = new Map();
  private sliceSize: number = 50; // 50cm slices for spatial hashing

  constructor(container: Container, config: CoilSolverConfig) {
    this.container = container;
    this.config = config;
  }

  /**
   * Add a placed cylinder to the manager
   */
  public addCylinder(cylinder: PlacedCylinder): void {
    this.placedCylinders.push(cylinder);
    this.updateSpatialIndex(cylinder);
  }

  /**
   * Get all placed cylinders
   */
  public getPlacedCylinders(): PlacedCylinder[] {
    return [...this.placedCylinders];
  }

  /**
   * Clear all placed cylinders
   */
  public clear(): void {
    this.placedCylinders = [];
    this.ySlices.clear();
  }

  /**
   * Update spatial index with a new cylinder
   */
  private updateSpatialIndex(cylinder: PlacedCylinder): void {
    const yMin = cylinder.center.y - this.getYExtent(cylinder) / 2;
    const yMax = cylinder.center.y + this.getYExtent(cylinder) / 2;

    const sliceStart = Math.floor(yMin / this.sliceSize);
    const sliceEnd = Math.ceil(yMax / this.sliceSize);

    for (let slice = sliceStart; slice <= sliceEnd; slice++) {
      if (!this.ySlices.has(slice)) {
        this.ySlices.set(slice, []);
      }
      this.ySlices.get(slice)!.push(cylinder);
    }
  }

  /**
   * Get the Y extent of a cylinder based on its orientation
   */
  private getYExtent(cylinder: PlacedCylinder): number {
    switch (cylinder.orientation) {
      case 'vertical':
        return cylinder.radius * 2;
      case 'horizontal-x':
        return cylinder.radius * 2;
      case 'horizontal-y':
        return cylinder.length;
    }
  }

  /**
   * Get cylinders that might be near a given Y position
   */
  private getCylindersNearY(y: number, yExtent: number): PlacedCylinder[] {
    const sliceStart = Math.floor((y - yExtent / 2) / this.sliceSize);
    const sliceEnd = Math.ceil((y + yExtent / 2) / this.sliceSize);

    const result: PlacedCylinder[] = [];
    const seen = new Set<string>();

    for (let slice = sliceStart; slice <= sliceEnd; slice++) {
      const cylinders = this.ySlices.get(slice) || [];
      for (const cyl of cylinders) {
        if (!seen.has(cyl.uniqueId)) {
          seen.add(cyl.uniqueId);
          result.push(cyl);
        }
      }
    }

    return result;
  }

  /**
   * Find all valley positions where a cylinder of given radius can nestle.
   * This is the core honeycomb packing logic.
   *
   * @param radius - Radius of the cylinder to place
   * @param length - Length of the cylinder
   * @param forHorizontal - True if placing horizontally (looking at XZ plane)
   */
  public findValleyPositions(
    radius: number,
    length: number,
    forHorizontal: boolean
  ): PlacementCandidate[] {
    const candidates: PlacementCandidate[] = [];

    // Get all horizontal cylinders if placing horizontal, or vertical if placing vertical
    const compatibleCylinders = this.placedCylinders.filter((cyl) => {
      if (forHorizontal) {
        // For horizontal cylinders, we look for valleys in the XZ plane
        // along any Y-depth where there are other horizontal cylinders
        return cyl.orientation === 'horizontal-y' || cyl.orientation === 'horizontal-x';
      } else {
        // For vertical cylinders, we look at the XY plane
        return cyl.orientation === 'vertical';
      }
    });

    if (compatibleCylinders.length < 2) {
      return candidates;
    }

    // Check all pairs of cylinders for potential valleys
    for (let i = 0; i < compatibleCylinders.length; i++) {
      for (let j = i + 1; j < compatibleCylinders.length; j++) {
        const cyl1 = compatibleCylinders[i];
        const cyl2 = compatibleCylinders[j];

        const valleyCandidate = this.calculateValleyCandidate(
          cyl1,
          cyl2,
          radius,
          length,
          forHorizontal
        );

        if (valleyCandidate) {
          candidates.push(valleyCandidate);
        }
      }
    }

    // Sort candidates by score (lower is better)
    return candidates.sort((a, b) => a.score - b.score);
  }

  /**
   * Calculate a valley candidate between two cylinders
   */
  private calculateValleyCandidate(
    cyl1: PlacedCylinder,
    cyl2: PlacedCylinder,
    radius: number,
    length: number,
    forHorizontal: boolean
  ): PlacementCandidate | null {
    if (forHorizontal) {
      return this.calculateHorizontalValley(cyl1, cyl2, radius, length);
    } else {
      return this.calculateVerticalValley(cyl1, cyl2, radius, length);
    }
  }

  /**
   * Calculate valley for horizontal cylinder placement
   * Looking at XZ cross-section at overlapping Y ranges
   */
  private calculateHorizontalValley(
    cyl1: PlacedCylinder,
    cyl2: PlacedCylinder,
    radius: number,
    length: number
  ): PlacementCandidate | null {
    // Check if cylinders have overlapping Y ranges
    const y1Min = cyl1.center.y - this.getYExtent(cyl1) / 2;
    const y1Max = cyl1.center.y + this.getYExtent(cyl1) / 2;
    const y2Min = cyl2.center.y - this.getYExtent(cyl2) / 2;
    const y2Max = cyl2.center.y + this.getYExtent(cyl2) / 2;

    const overlapMin = Math.max(y1Min, y2Min);
    const overlapMax = Math.min(y1Max, y2Max);

    if (overlapMax <= overlapMin) {
      return null; // No Y overlap, can't form a valley
    }

    // Check if the new cylinder's length fits in the overlap
    if (length > overlapMax - overlapMin + this.config.cylinderMargin) {
      return null;
    }

    // Get circles in XZ plane (at the center Z of each cylinder)
    const circle1: Circle2D = {
      x: cyl1.center.x,
      z: cyl1.center.z + cyl1.radius, // Center Z of horizontal cylinder
      radius: cyl1.radius,
    };

    const circle2: Circle2D = {
      x: cyl2.center.x,
      z: cyl2.center.z + cyl2.radius,
      radius: cyl2.radius,
    };

    // Check Z difference - cylinders should be at similar heights
    if (Math.abs(circle1.z - circle2.z) > (cyl1.radius + cyl2.radius) * 1.2) {
      return null;
    }

    // Calculate nest position
    const nestPos = CylinderGeometry.calculateNestPosition(circle1, circle2, radius);
    if (!nestPos) {
      return null;
    }

    // Validate position is within container bounds
    if (!this.isValidPosition(nestPos.x, (overlapMin + overlapMax) / 2, nestPos.z, radius, length, 'horizontal-y')) {
      return null;
    }

    // Check for collisions with all placed cylinders
    if (this.hasCollision(nestPos.x, (overlapMin + overlapMax) / 2, nestPos.z - radius, radius, length, 'horizontal-y')) {
      return null;
    }

    // Calculate Y position (center of overlap)
    const yPos = (overlapMin + overlapMax) / 2;

    // Calculate corner position
    const cornerPos = {
      x: nestPos.x - radius,
      y: yPos - length / 2,
      z: nestPos.z - radius, // Bottom of cylinder
    };

    const centerPos = {
      x: nestPos.x,
      y: yPos,
      z: nestPos.z - radius,
    };

    const score = this.calculateScore(cornerPos);

    return {
      position: cornerPos,
      center: centerPos,
      orientation: 'horizontal-y',
      score,
      supportType: 'nested',
      supportingIds: [cyl1.uniqueId, cyl2.uniqueId],
    };
  }

  /**
   * Calculate valley for vertical cylinder placement
   * Looking at XY cross-section at similar Z levels
   */
  private calculateVerticalValley(
    cyl1: PlacedCylinder,
    cyl2: PlacedCylinder,
    radius: number,
    length: number
  ): PlacementCandidate | null {
    // For vertical cylinders, check if they're at the same base Z level
    const z1Base = cyl1.center.z;
    const z2Base = cyl2.center.z;

    // Must be at similar base heights
    if (Math.abs(z1Base - z2Base) > Math.max(cyl1.radius, cyl2.radius) * 0.5) {
      return null;
    }

    // Get circles in XY plane
    const circle1: Circle2D = {
      x: cyl1.center.x,
      z: cyl1.center.y, // Using Y as the "Z" for 2D calculation
      radius: cyl1.radius,
    };

    const circle2: Circle2D = {
      x: cyl2.center.x,
      z: cyl2.center.y,
      radius: cyl2.radius,
    };

    // Calculate nest position in XY plane
    const nestPos = CylinderGeometry.calculateNestPosition(circle1, circle2, radius);
    if (!nestPos) {
      return null;
    }

    // nestPos.z is actually the Y coordinate in container space
    const xPos = nestPos.x;
    const yPos = nestPos.z;
    const zPos = Math.max(z1Base, z2Base); // Start at the higher base

    // Validate position is within container bounds
    if (!this.isValidPosition(xPos, yPos, zPos, radius, length, 'vertical')) {
      return null;
    }

    // Check for collisions
    if (this.hasCollision(xPos, yPos, zPos, radius, length, 'vertical')) {
      return null;
    }

    const cornerPos = {
      x: xPos - radius,
      y: yPos - radius,
      z: zPos,
    };

    const centerPos = {
      x: xPos,
      y: yPos,
      z: zPos,
    };

    const score = this.calculateScore(cornerPos);

    return {
      position: cornerPos,
      center: centerPos,
      orientation: 'vertical',
      score,
      supportType: 'nested',
      supportingIds: [cyl1.uniqueId, cyl2.uniqueId],
    };
  }

  /**
   * Find positions to stack on top of existing cylinders
   */
  public findStackingPositions(
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y'
  ): PlacementCandidate[] {
    const candidates: PlacementCandidate[] = [];

    for (const baseCyl of this.placedCylinders) {
      // Only stack on cylinders with same orientation
      if (baseCyl.orientation !== orientation) continue;

      // Check if cylinder is stackable
      if (!baseCyl.item.stackable) continue;

      // Calculate stacking position
      let stackZ: number;
      if (orientation === 'vertical') {
        stackZ = baseCyl.center.z + baseCyl.length;
      } else {
        stackZ = baseCyl.center.z + baseCyl.radius * 2;
      }

      const centerPos = {
        x: baseCyl.center.x,
        y: baseCyl.center.y,
        z: stackZ,
      };

      // Validate position
      if (!this.isValidPosition(centerPos.x, centerPos.y, centerPos.z, radius, length, orientation)) {
        continue;
      }

      // Check collisions
      if (this.hasCollision(centerPos.x, centerPos.y, centerPos.z, radius, length, orientation)) {
        continue;
      }

      // Calculate corner position
      let cornerPos: { x: number; y: number; z: number };
      if (orientation === 'vertical') {
        cornerPos = {
          x: centerPos.x - radius,
          y: centerPos.y - radius,
          z: stackZ,
        };
      } else {
        cornerPos = {
          x: centerPos.x - radius,
          y: centerPos.y - length / 2,
          z: stackZ,
        };
      }

      const score = this.calculateScore(cornerPos);

      candidates.push({
        position: cornerPos,
        center: centerPos,
        orientation,
        score,
        supportType: 'stacked',
        supportingIds: [baseCyl.uniqueId],
      });
    }

    return candidates.sort((a, b) => a.score - b.score);
  }

  /**
   * Find floor positions for initial placement
   */
  public findFloorPositions(
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x'
  ): PlacementCandidate[] {
    const candidates: PlacementCandidate[] = [];

    // Grid-based search for floor positions
    const dims = this.getOrientedDimensions(radius, length, orientation);
    const stepX = dims.x;
    const stepY = dims.y;

    const margin = this.config.wallMargin;

    for (let y = margin; y + dims.y <= this.container.dimensions.length - margin; y += stepY * 0.5) {
      for (let x = margin; x + dims.x <= this.container.dimensions.width - margin; x += stepX * 0.5) {
        const centerPos = this.getCenterFromCorner({ x, y, z: 0 }, radius, length, orientation);

        // Check for collisions
        if (this.hasCollision(centerPos.x, centerPos.y, centerPos.z, radius, length, orientation)) {
          continue;
        }

        const cornerPos = { x, y, z: 0 };
        const score = this.calculateScore(cornerPos);

        candidates.push({
          position: cornerPos,
          center: centerPos,
          orientation,
          score,
          supportType: 'floor',
          supportingIds: [],
        });
      }
    }

    return candidates.sort((a, b) => a.score - b.score);
  }

  /**
   * Get center position from corner position
   */
  private getCenterFromCorner(
    corner: { x: number; y: number; z: number },
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x'
  ): { x: number; y: number; z: number } {
    switch (orientation) {
      case 'vertical':
        return {
          x: corner.x + radius,
          y: corner.y + radius,
          z: corner.z,
        };
      case 'horizontal-y':
        return {
          x: corner.x + radius,
          y: corner.y + length / 2,
          z: corner.z,
        };
      case 'horizontal-x':
        return {
          x: corner.x + length / 2,
          y: corner.y + radius,
          z: corner.z,
        };
    }
  }

  /**
   * Get dimensions for oriented cylinder
   */
  private getOrientedDimensions(
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x'
  ): { x: number; y: number; z: number } {
    const diameter = radius * 2;
    switch (orientation) {
      case 'vertical':
        return { x: diameter, y: diameter, z: length };
      case 'horizontal-y':
        return { x: diameter, y: length, z: diameter };
      case 'horizontal-x':
        return { x: length, y: diameter, z: diameter };
    }
  }

  /**
   * Check if a position is within container bounds
   */
  private isValidPosition(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x'
  ): boolean {
    const margin = this.config.wallMargin;
    const dims = this.getOrientedDimensions(radius, length, orientation);

    // Get corner from center
    let corner: { x: number; y: number; z: number };
    switch (orientation) {
      case 'vertical':
        corner = { x: cx - radius, y: cy - radius, z: cz };
        break;
      case 'horizontal-y':
        corner = { x: cx - radius, y: cy - length / 2, z: cz };
        break;
      case 'horizontal-x':
        corner = { x: cx - length / 2, y: cy - radius, z: cz };
        break;
    }

    return (
      corner.x >= margin &&
      corner.x + dims.x <= this.container.dimensions.width - margin &&
      corner.y >= margin &&
      corner.y + dims.y <= this.container.dimensions.length - margin &&
      corner.z >= 0 &&
      corner.z + dims.z <= this.container.dimensions.height
    );
  }

  /**
   * Check if placing a cylinder at position would cause collision
   */
  private hasCollision(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x'
  ): boolean {
    const margin = this.config.cylinderMargin;

    // Get potentially nearby cylinders for quick filtering
    const dims = this.getOrientedDimensions(radius, length, orientation);
    const nearbyCylinders = this.getCylindersNearY(cy, dims.y + 100);

    for (const placed of nearbyCylinders) {
      if (this.cylindersOverlap(cx, cy, cz, radius, length, orientation, placed, margin)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check if two cylinders overlap
   */
  private cylindersOverlap(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x',
    placed: PlacedCylinder,
    margin: number
  ): boolean {
    // Quick AABB check first
    const dims1 = this.getOrientedDimensions(radius, length, orientation);
    const dims2 = this.getOrientedDimensions(placed.radius, placed.length, placed.orientation);

    // Get corners
    let c1: { x: number; y: number; z: number };
    switch (orientation) {
      case 'vertical':
        c1 = { x: cx - radius, y: cy - radius, z: cz };
        break;
      case 'horizontal-y':
        c1 = { x: cx - radius, y: cy - length / 2, z: cz };
        break;
      case 'horizontal-x':
        c1 = { x: cx - length / 2, y: cy - radius, z: cz };
        break;
    }

    const c2 = placed.position;

    // AABB overlap
    const noOverlap =
      c1.x + dims1.x <= c2.x + margin ||
      c1.x >= c2.x + dims2.x - margin ||
      c1.y + dims1.y <= c2.y + margin ||
      c1.y >= c2.y + dims2.y - margin ||
      c1.z + dims1.z <= c2.z + margin ||
      c1.z >= c2.z + dims2.z - margin;

    if (noOverlap) {
      return false;
    }

    // For same-orientation cylinders, do precise circular check
    if (orientation === placed.orientation) {
      return this.preciseCircleOverlap(cx, cy, cz, radius, length, orientation, placed, margin);
    }

    // For different orientations, AABB is sufficient
    return true;
  }

  /**
   * Precise overlap check using circular geometry
   */
  private preciseCircleOverlap(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    length: number,
    orientation: 'vertical' | 'horizontal-y' | 'horizontal-x',
    placed: PlacedCylinder,
    margin: number
  ): boolean {
    switch (orientation) {
      case 'vertical': {
        // Check Z overlap
        const z1Min = cz;
        const z1Max = cz + length;
        const z2Min = placed.center.z;
        const z2Max = placed.center.z + placed.length;

        if (z1Max <= z2Min + margin || z1Min >= z2Max - margin) {
          return false;
        }

        // Check XY circle overlap
        const dist = Math.sqrt(
          Math.pow(cx - placed.center.x, 2) + Math.pow(cy - placed.center.y, 2)
        );
        return dist < radius + placed.radius - margin;
      }

      case 'horizontal-y': {
        // Check Y overlap
        const y1Min = cy - length / 2;
        const y1Max = cy + length / 2;
        const y2Min = placed.center.y - placed.length / 2;
        const y2Max = placed.center.y + placed.length / 2;

        if (y1Max <= y2Min + margin || y1Min >= y2Max - margin) {
          return false;
        }

        // Check XZ circle overlap
        const dist = Math.sqrt(
          Math.pow(cx - placed.center.x, 2) +
          Math.pow((cz + radius) - (placed.center.z + placed.radius), 2)
        );
        return dist < radius + placed.radius - margin;
      }

      case 'horizontal-x': {
        // Check X overlap
        const x1Min = cx - length / 2;
        const x1Max = cx + length / 2;
        const x2Min = placed.center.x - placed.length / 2;
        const x2Max = placed.center.x + placed.length / 2;

        if (x1Max <= x2Min + margin || x1Min >= x2Max - margin) {
          return false;
        }

        // Check YZ circle overlap
        const dist = Math.sqrt(
          Math.pow(cy - placed.center.y, 2) +
          Math.pow((cz + radius) - (placed.center.z + placed.radius), 2)
        );
        return dist < radius + placed.radius - margin;
      }
    }
  }

  /**
   * Calculate placement score (lower is better)
   * Prioritizes: back of container -> bottom -> left
   */
  private calculateScore(position: { x: number; y: number; z: number }): number {
    return (
      position.y * this.config.depthWeight +
      position.z * this.config.heightWeight +
      position.x * this.config.widthWeight
    );
  }
}
