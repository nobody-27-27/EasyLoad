// src/core/solvers/coil-solver/optimized-solver.ts

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
} from './types';
import { DEFAULT_COIL_SOLVER_CONFIG, ORIENTATION_ROTATIONS } from './types';
import type { CylinderOrientation } from '../../math/cylinder-math/cylinder-geometry';

/**
 * Candidate position for placing a cylinder
 */
interface CandidatePosition {
  x: number;           // Center X
  y: number;           // Start Y (for horizontal) or Center Y (for vertical)
  z: number;           // Bottom Z
  orientation: CylinderOrientation;
  score: number;       // Lower is better
}

/**
 * OptimizedCoilSolver - Advanced 3D cylinder packing algorithm
 *
 * Key features:
 * - Dynamic position generation based on already-placed cylinders
 * - Tries BOTH orientations for every single item
 * - Valley/nesting detection for tight honeycomb packing
 * - Multiple sorting strategies with best result selection
 * - Precise circular collision detection
 */
export class OptimizedCoilSolver {
  private container: Container;
  private config: CoilSolverConfig;

  constructor(container: Container, config: Partial<CoilSolverConfig> = {}) {
    this.container = container;
    this.config = { ...DEFAULT_COIL_SOLVER_CONFIG, ...config };
  }

  /**
   * Main solve method - tries multiple strategies and returns best result
   */
  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinderItems = items.filter((item) => item.type === 'cylinder');

    if (cylinderItems.length === 0) {
      return this.emptyResult();
    }

    // Expand quantities into individual items
    const flatItems: CargoItem[] = [];
    for (const item of cylinderItems) {
      for (let i = 0; i < item.quantity; i++) {
        flatItems.push({ ...item, quantity: 1 });
      }
    }

    const totalItems = flatItems.length;

    // Try multiple sorting strategies
    const strategies = [
      { name: 'volume-desc', fn: this.sortByVolumeDesc.bind(this) },
      { name: 'diameter-desc', fn: this.sortByDiameterDesc.bind(this) },
      { name: 'length-desc', fn: this.sortByLengthDesc.bind(this) },
      { name: 'volume-asc', fn: this.sortByVolumeAsc.bind(this) },
      { name: 'mixed', fn: this.sortMixed.bind(this) },
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } | null = null;
    let bestScore = -Infinity;
    let bestStrategy = '';

    for (const strategy of strategies) {
      const sortedItems = strategy.fn([...flatItems]);
      const result = this.packItems(sortedItems);

      // Score: prioritize placing all items, then efficiency
      const placedRatio = result.placed.length / totalItems;
      const efficiency = this.calculateEfficiency(result.placed);
      const score = placedRatio * 10000 + efficiency * 100;

      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
        bestStrategy = strategy.name;
      }

      // Early exit if all items placed
      if (result.placed.length === totalItems) {
        console.log(`✓ All ${totalItems} items placed with strategy: ${strategy.name}`);
        break;
      }
    }

    console.log(`Best: ${bestStrategy} - Placed ${bestResult!.placed.length}/${totalItems}`);

    return {
      placedCylinders: bestResult!.placed,
      unplacedItems: bestResult!.unplaced,
      statistics: this.calculateStatistics(bestResult!.placed, bestResult!.unplaced.length),
    };
  }

  /**
   * Core packing algorithm - places items one by one in best position
   */
  private packItems(items: CargoItem[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    for (const item of items) {
      const radius = item.dimensions.width / 2;
      const length = item.dimensions.height;

      // Find best position trying BOTH orientations
      const bestPos = this.findBestPosition(radius, length, placed);

      if (bestPos) {
        placed.push(this.createPlacedCylinder(item, bestPos, radius, length));
      } else {
        unplaced.push(item);
      }
    }

    return { placed, unplaced };
  }

  /**
   * Find the best position for a cylinder, trying all valid positions and orientations
   */
  private findBestPosition(
    radius: number,
    length: number,
    placed: PlacedCylinder[]
  ): CandidatePosition | null {
    const candidates: CandidatePosition[] = [];
    const margin = this.config.wallMargin;
    const gap = this.config.cylinderMargin;

    // Try both orientations
    const orientations: CylinderOrientation[] = ['horizontal-y', 'vertical'];

    for (const orientation of orientations) {
      // Check if this orientation fits in container at all
      if (!this.orientationFits(radius, length, orientation)) {
        continue;
      }

      // Generate candidate positions for this orientation
      const positions = this.generateCandidatePositions(radius, length, orientation, placed, margin, gap);

      for (const pos of positions) {
        if (this.isValidPosition(pos.x, pos.y, pos.z, radius, length, orientation, placed, gap)) {
          const score = this.scorePosition(pos.x, pos.y, pos.z, orientation);
          candidates.push({ x: pos.x, y: pos.y, z: pos.z, orientation, score });
        }
      }
    }

    if (candidates.length === 0) {
      return null;
    }

    // Return position with lowest score (best fit)
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
  }

  /**
   * Check if an orientation fits in the container at all
   */
  private orientationFits(radius: number, length: number, orientation: CylinderOrientation): boolean {
    const diameter = radius * 2;
    const { width, length: containerLength, height } = this.container.dimensions;

    if (orientation === 'horizontal-y') {
      // Lying along Y axis: needs diameter in X, length in Y, diameter in Z
      return diameter <= width && length <= containerLength && diameter <= height;
    } else {
      // Standing vertical: needs diameter in X, diameter in Y, length in Z
      return diameter <= width && diameter <= containerLength && length <= height;
    }
  }

  /**
   * Generate all candidate positions for a cylinder
   */
  private generateCandidatePositions(
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder[],
    margin: number,
    gap: number
  ): Array<{ x: number; y: number; z: number }> {
    const positions: Array<{ x: number; y: number; z: number }> = [];
    const diameter = radius * 2;

    if (orientation === 'horizontal-y') {
      // Horizontal cylinder: axis along Y
      // Position = center X, start Y, bottom Z

      // 1. Floor positions - systematic grid
      const rowHeight = radius * Math.sqrt(3); // Honeycomb row spacing

      // Generate Y positions
      const yPositions: number[] = [];
      for (let y = margin; y + length <= this.container.dimensions.length - margin; y += length * 0.5) {
        yPositions.push(y);
      }
      // Also add positions based on existing cylinder ends
      for (const p of placed) {
        if (p.orientation === 'horizontal-y') {
          const endY = p.position.y + p.length + gap;
          if (endY + length <= this.container.dimensions.length - margin) {
            yPositions.push(endY);
          }
        }
      }

      for (const y of [...new Set(yPositions)]) {
        // Floor level rows (honeycomb pattern)
        for (let row = 0; row < 20; row++) {
          const z = row * rowHeight;
          if (z + diameter > this.container.dimensions.height - margin) break;

          const xOffset = (row % 2 === 1) ? radius : 0;

          for (let x = margin + radius + xOffset; x + radius <= this.container.dimensions.width - margin; x += diameter + gap) {
            positions.push({ x, y, z });
          }
        }
      }

      // 2. Valley positions - nestle between existing horizontal cylinders
      for (const p1 of placed) {
        if (p1.orientation !== 'horizontal-y') continue;

        for (const p2 of placed) {
          if (p2.orientation !== 'horizontal-y' || p1 === p2) continue;

          // Check if they're on the same Z level and Y overlaps
          if (Math.abs(p1.position.z - p2.position.z) > gap) continue;

          const yOverlap = Math.min(p1.position.y + p1.length, p2.position.y + p2.length) -
                          Math.max(p1.position.y, p2.position.y);
          if (yOverlap < length * 0.5) continue;

          // Calculate valley position
          const dist = Math.abs(p1.center.x - p2.center.x);
          const sumRadii = p1.radius + p2.radius;

          if (dist > sumRadii - gap && dist < sumRadii + diameter + gap * 2) {
            // There's a valley between these two
            const midX = (p1.center.x + p2.center.x) / 2;
            const valleyZ = p1.position.z + p1.radius * Math.sqrt(3);
            const valleyY = Math.max(p1.position.y, p2.position.y);

            if (valleyZ + diameter <= this.container.dimensions.height) {
              positions.push({ x: midX, y: valleyY, z: valleyZ });
            }
          }
        }
      }

      // 3. Stacking on top of single horizontal cylinders
      for (const p of placed) {
        if (p.orientation !== 'horizontal-y') continue;

        const stackZ = p.position.z + p.radius * 2;
        if (stackZ + diameter > this.container.dimensions.height) continue;

        // Stack directly on top
        positions.push({ x: p.center.x, y: p.position.y, z: stackZ });
      }

    } else {
      // Vertical cylinder: axis along Z
      // Position = center X, center Y, bottom Z

      // 1. Floor positions - hexagonal grid
      const rowSpacing = radius * Math.sqrt(3);

      for (let rowNum = 0; rowNum < 50; rowNum++) {
        const y = margin + radius + rowNum * rowSpacing;
        if (y + radius > this.container.dimensions.length - margin) break;

        const xOffset = (rowNum % 2 === 1) ? radius : 0;

        for (let x = margin + radius + xOffset; x + radius <= this.container.dimensions.width - margin; x += diameter + gap) {
          // Stack vertically
          for (let z = 0; z + length <= this.container.dimensions.height; z += length) {
            positions.push({ x, y, z });
          }
        }
      }

      // 2. Positions on top of vertical cylinders
      for (const p of placed) {
        if (p.orientation !== 'vertical') continue;

        const stackZ = p.position.z + p.length;
        if (stackZ + length > this.container.dimensions.height) continue;

        positions.push({ x: p.center.x, y: p.center.y, z: stackZ });
      }

      // 3. Valley positions between vertical cylinders (in XY plane)
      for (const p1 of placed) {
        if (p1.orientation !== 'vertical') continue;

        for (const p2 of placed) {
          if (p2.orientation !== 'vertical' || p1 === p2) continue;
          if (Math.abs(p1.position.z - p2.position.z) > gap) continue;

          const dx = p2.center.x - p1.center.x;
          const dy = p2.center.y - p1.center.y;
          const dist = Math.sqrt(dx * dx + dy * dy);
          const sumRadii = p1.radius + p2.radius;

          if (dist > sumRadii + gap && dist < sumRadii + diameter * 2 + gap) {
            // Find third position forming equilateral arrangement
            const midX = (p1.center.x + p2.center.x) / 2;
            const midY = (p1.center.y + p2.center.y) / 2;

            // Perpendicular offset for triangular packing
            const perpX = -dy / dist * rowSpacing;
            const perpY = dx / dist * rowSpacing;

            for (const sign of [1, -1]) {
              const nestX = midX + sign * perpX;
              const nestY = midY + sign * perpY;

              if (nestX - radius >= margin && nestX + radius <= this.container.dimensions.width - margin &&
                  nestY - radius >= margin && nestY + radius <= this.container.dimensions.length - margin) {
                positions.push({ x: nestX, y: nestY, z: p1.position.z });
              }
            }
          }
        }
      }
    }

    return positions;
  }

  /**
   * Check if a position is valid (no collisions, within bounds)
   */
  private isValidPosition(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder[],
    gap: number
  ): boolean {
    // Bounds check
    if (!this.isWithinBounds(x, y, z, radius, length, orientation)) {
      return false;
    }

    // Collision check with all placed cylinders
    for (const p of placed) {
      if (this.cylindersCollide(x, y, z, radius, length, orientation, p, gap)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Check if cylinder is within container bounds
   */
  private isWithinBounds(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation
  ): boolean {
    const margin = this.config.wallMargin;
    const { width, length: containerLength, height } = this.container.dimensions;
    const diameter = radius * 2;

    if (orientation === 'horizontal-y') {
      // Horizontal: center X, start Y, bottom Z
      return x - radius >= margin &&
             x + radius <= width - margin &&
             y >= margin &&
             y + length <= containerLength - margin &&
             z >= 0 &&
             z + diameter <= height;
    } else {
      // Vertical: center X, center Y, bottom Z
      return x - radius >= margin &&
             x + radius <= width - margin &&
             y - radius >= margin &&
             y + radius <= containerLength - margin &&
             z >= 0 &&
             z + length <= height;
    }
  }

  /**
   * Check if two cylinders collide
   */
  private cylindersCollide(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    other: PlacedCylinder,
    gap: number
  ): boolean {
    const minDist = radius + other.radius + gap;

    if (orientation === 'horizontal-y' && other.orientation === 'horizontal-y') {
      // Both horizontal along Y
      // Check Y overlap first
      const y1Start = y, y1End = y + length;
      const y2Start = other.position.y, y2End = other.position.y + other.length;

      if (y1End <= y2Start || y1Start >= y2End) {
        return false; // No Y overlap
      }

      // Check circle collision in XZ plane
      const c1z = z + radius;
      const c2z = other.position.z + other.radius;
      const dist = Math.sqrt(Math.pow(x - other.center.x, 2) + Math.pow(c1z - c2z, 2));

      return dist < minDist;

    } else if (orientation === 'vertical' && other.orientation === 'vertical') {
      // Both vertical along Z
      // Check Z overlap first
      const z1End = z + length;
      const z2End = other.position.z + other.length;

      if (z1End <= other.position.z || z >= z2End) {
        return false; // No Z overlap
      }

      // Check circle collision in XY plane
      const dist = Math.sqrt(Math.pow(x - other.center.x, 2) + Math.pow(y - other.center.y, 2));

      return dist < minDist;

    } else {
      // Mixed orientations - use AABB for simplicity
      const bb1 = this.getBoundingBox(x, y, z, radius, length, orientation);
      const bb2 = this.getPlacedBoundingBox(other);

      return !(bb1.maxX <= bb2.minX + gap ||
               bb1.minX >= bb2.maxX - gap ||
               bb1.maxY <= bb2.minY + gap ||
               bb1.minY >= bb2.maxY - gap ||
               bb1.maxZ <= bb2.minZ + gap ||
               bb1.minZ >= bb2.maxZ - gap);
    }
  }

  /**
   * Get bounding box for a cylinder being placed
   */
  private getBoundingBox(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation
  ): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
    const diameter = radius * 2;

    if (orientation === 'horizontal-y') {
      return {
        minX: x - radius, maxX: x + radius,
        minY: y, maxY: y + length,
        minZ: z, maxZ: z + diameter,
      };
    } else {
      return {
        minX: x - radius, maxX: x + radius,
        minY: y - radius, maxY: y + radius,
        minZ: z, maxZ: z + length,
      };
    }
  }

  /**
   * Get bounding box for an already-placed cylinder
   */
  private getPlacedBoundingBox(p: PlacedCylinder): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
    const diameter = p.radius * 2;

    if (p.orientation === 'horizontal-y') {
      return {
        minX: p.center.x - p.radius, maxX: p.center.x + p.radius,
        minY: p.position.y, maxY: p.position.y + p.length,
        minZ: p.position.z, maxZ: p.position.z + diameter,
      };
    } else {
      return {
        minX: p.center.x - p.radius, maxX: p.center.x + p.radius,
        minY: p.center.y - p.radius, maxY: p.center.y + p.radius,
        minZ: p.position.z, maxZ: p.position.z + p.length,
      };
    }
  }

  /**
   * Score a position - lower is better
   * Prioritize: filling from back (low Y), bottom (low Z), left (low X)
   */
  private scorePosition(x: number, y: number, z: number, orientation: CylinderOrientation): number {
    // Normalize to container dimensions
    const normY = y / this.container.dimensions.length;
    const normZ = z / this.container.dimensions.height;
    const normX = x / this.container.dimensions.width;

    // Horizontal cylinders: prioritize filling depth (Y), then height (Z), then width (X)
    // Vertical cylinders: same priority

    // Weight Y most heavily to fill from back to front
    // Then Z to fill from bottom to top
    // Then X to fill from left to right

    if (orientation === 'horizontal-y') {
      return normY * 10000 + normZ * 100 + normX;
    } else {
      return normY * 10000 + normZ * 100 + normX;
    }
  }

  /**
   * Create a PlacedCylinder object
   */
  private createPlacedCylinder(
    item: CargoItem,
    pos: CandidatePosition,
    radius: number,
    length: number
  ): PlacedCylinder {
    let cornerPos: { x: number; y: number; z: number };
    let centerPos: { x: number; y: number; z: number };

    if (pos.orientation === 'horizontal-y') {
      // Horizontal: x is center, y is start, z is bottom
      cornerPos = { x: pos.x - radius, y: pos.y, z: pos.z };
      centerPos = { x: pos.x, y: pos.y + length / 2, z: pos.z + radius };
    } else {
      // Vertical: x is center, y is center, z is bottom
      cornerPos = { x: pos.x - radius, y: pos.y - radius, z: pos.z };
      centerPos = { x: pos.x, y: pos.y, z: pos.z + length / 2 };
    }

    return {
      item,
      uniqueId: `${item.id}_${pos.orientation[0]}_${Math.random().toString(36).substr(2, 6)}`,
      position: cornerPos,
      center: centerPos,
      radius,
      length,
      orientation: pos.orientation,
      rotation: ORIENTATION_ROTATIONS[pos.orientation],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  // Sorting functions
  private sortByVolumeDesc(items: CargoItem[]): CargoItem[] {
    return items.sort((a, b) => {
      const volA = Math.PI * Math.pow(a.dimensions.width / 2, 2) * a.dimensions.height;
      const volB = Math.PI * Math.pow(b.dimensions.width / 2, 2) * b.dimensions.height;
      return volB - volA;
    });
  }

  private sortByVolumeAsc(items: CargoItem[]): CargoItem[] {
    return items.sort((a, b) => {
      const volA = Math.PI * Math.pow(a.dimensions.width / 2, 2) * a.dimensions.height;
      const volB = Math.PI * Math.pow(b.dimensions.width / 2, 2) * b.dimensions.height;
      return volA - volB;
    });
  }

  private sortByDiameterDesc(items: CargoItem[]): CargoItem[] {
    return items.sort((a, b) => b.dimensions.width - a.dimensions.width);
  }

  private sortByLengthDesc(items: CargoItem[]): CargoItem[] {
    return items.sort((a, b) => b.dimensions.height - a.dimensions.height);
  }

  private sortMixed(items: CargoItem[]): CargoItem[] {
    // Group by similar dimensions, then sort by volume
    return items.sort((a, b) => {
      const diamA = a.dimensions.width;
      const diamB = b.dimensions.width;
      // Group by diameter first (within 10% tolerance)
      if (Math.abs(diamA - diamB) > diamA * 0.1) {
        return diamB - diamA;
      }
      // Then by length
      return b.dimensions.height - a.dimensions.height;
    });
  }

  /**
   * Calculate packing efficiency
   */
  private calculateEfficiency(placed: PlacedCylinder[]): number {
    if (placed.length === 0) return 0;

    let totalCylinderVolume = 0;
    let maxX = 0, maxY = 0, maxZ = 0;

    for (const cyl of placed) {
      totalCylinderVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;

      const bb = this.getPlacedBoundingBox(cyl);
      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
      maxZ = Math.max(maxZ, bb.maxZ);
    }

    const usedVolume = maxX * maxY * maxZ;
    return usedVolume > 0 ? totalCylinderVolume / usedVolume : 0;
  }

  /**
   * Calculate statistics
   */
  private calculateStatistics(placed: PlacedCylinder[], failedCount: number): PackingStatistics {
    const efficiency = this.calculateEfficiency(placed);

    let totalVolume = 0;
    let maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const cyl of placed) {
      totalVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;
      layers.add(cyl.layerId);

      const bb = this.getPlacedBoundingBox(cyl);
      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
      maxZ = Math.max(maxZ, bb.maxZ);
    }

    return {
      totalVolumePlaced: totalVolume,
      containerVolumeUsed: maxX * maxY * maxZ,
      volumeEfficiency: efficiency,
      layerCount: layers.size,
      itemsPlaced: placed.length,
      itemsFailed: failedCount,
    };
  }

  /**
   * Empty result
   */
  private emptyResult(): CoilSolverResult {
    return {
      placedCylinders: [],
      unplacedItems: [],
      statistics: {
        totalVolumePlaced: 0,
        containerVolumeUsed: 0,
        volumeEfficiency: 0,
        layerCount: 0,
        itemsPlaced: 0,
        itemsFailed: 0,
      },
    };
  }
}
