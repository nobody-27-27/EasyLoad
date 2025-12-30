// src/core/solvers/coil-solver/optimized-solver.ts

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';
import type { CylinderOrientation } from '../../math/cylinder-math/cylinder-geometry';

/**
 * Candidate position for placing a cylinder
 */
interface CandidatePosition {
  x: number;
  y: number;
  z: number;
  orientation: CylinderOrientation;
  score: number;
}

/**
 * OptimizedCoilSolver - Tight 3D cylinder packing with honeycomb optimization
 *
 * Uses true honeycomb packing with √3 row spacing for optimal density.
 * Tries both orientations for every item and multiple sorting strategies.
 */
export class OptimizedCoilSolver {
  private container: Container;

  // Use minimal gaps for tight packing
  private readonly WALL_MARGIN = 1; // 1cm from walls
  private readonly CYLINDER_GAP = 0.5; // 0.5cm between cylinders (minimal)

  constructor(container: Container, _config: Partial<CoilSolverConfig> = {}) {
    this.container = container;
  }

  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinderItems = items.filter((item) => item.type === 'cylinder');

    if (cylinderItems.length === 0) {
      return this.emptyResult();
    }

    // Expand quantities
    const flatItems: CargoItem[] = [];
    for (const item of cylinderItems) {
      for (let i = 0; i < item.quantity; i++) {
        flatItems.push({ ...item, quantity: 1 });
      }
    }

    const totalItems = flatItems.length;
    console.log(`Solving for ${totalItems} cylinders in container ${this.container.dimensions.width}x${this.container.dimensions.length}x${this.container.dimensions.height}`);

    // Try multiple strategies
    const strategies = [
      { name: 'diameter-desc', fn: (arr: CargoItem[]) => this.sortByDiameter(arr, true) },
      { name: 'diameter-asc', fn: (arr: CargoItem[]) => this.sortByDiameter(arr, false) },
      { name: 'volume-desc', fn: (arr: CargoItem[]) => this.sortByVolume(arr, true) },
      { name: 'length-desc', fn: (arr: CargoItem[]) => this.sortByLength(arr, true) },
      { name: 'mixed', fn: (arr: CargoItem[]) => this.sortMixed(arr) },
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } | null = null;
    let bestScore = -1;
    let bestStrategy = '';

    for (const strategy of strategies) {
      const sortedItems = strategy.fn([...flatItems]);
      const result = this.packGreedy(sortedItems);

      const score = result.placed.length * 1000 + this.calculateEfficiency(result.placed) * 100;

      if (score > bestScore) {
        bestScore = score;
        bestResult = result;
        bestStrategy = strategy.name;
      }

      if (result.placed.length === totalItems) {
        console.log(`✓ All ${totalItems} items placed with: ${strategy.name}`);
        break;
      }
    }

    console.log(`Best: ${bestStrategy} - ${bestResult!.placed.length}/${totalItems} placed`);

    return {
      placedCylinders: bestResult!.placed,
      unplacedItems: bestResult!.unplaced,
      statistics: this.calculateStatistics(bestResult!.placed, bestResult!.unplaced.length),
    };
  }

  /**
   * Greedy packing - place each item in best available position
   */
  private packGreedy(items: CargoItem[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    for (const item of items) {
      const radius = item.dimensions.width / 2;
      const length = item.dimensions.height;

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
   * Find best position trying both orientations
   */
  private findBestPosition(
    radius: number,
    length: number,
    placed: PlacedCylinder[]
  ): CandidatePosition | null {
    const candidates: CandidatePosition[] = [];

    // Try horizontal orientation (axis along Y - container length)
    if (this.canFitHorizontal(radius, length)) {
      const horizontalPositions = this.generateHorizontalPositions(radius, length, placed);
      for (const pos of horizontalPositions) {
        if (this.isValidPosition(pos.x, pos.y, pos.z, radius, length, 'horizontal-y', placed)) {
          candidates.push({
            ...pos,
            orientation: 'horizontal-y',
            score: this.scorePosition(pos.x, pos.y, pos.z, radius, length, 'horizontal-y', placed),
          });
        }
      }
    }

    // Try vertical orientation (axis along Z - standing up)
    if (this.canFitVertical(radius, length)) {
      const verticalPositions = this.generateVerticalPositions(radius, length, placed);
      for (const pos of verticalPositions) {
        if (this.isValidPosition(pos.x, pos.y, pos.z, radius, length, 'vertical', placed)) {
          candidates.push({
            ...pos,
            orientation: 'vertical',
            score: this.scorePosition(pos.x, pos.y, pos.z, radius, length, 'vertical', placed),
          });
        }
      }
    }

    if (candidates.length === 0) return null;

    // Return lowest score (best fit)
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
  }

  private canFitHorizontal(radius: number, length: number): boolean {
    const d = radius * 2;
    return d <= this.container.dimensions.width - 2 * this.WALL_MARGIN &&
           length <= this.container.dimensions.length - 2 * this.WALL_MARGIN &&
           d <= this.container.dimensions.height;
  }

  private canFitVertical(radius: number, length: number): boolean {
    const d = radius * 2;
    return d <= this.container.dimensions.width - 2 * this.WALL_MARGIN &&
           d <= this.container.dimensions.length - 2 * this.WALL_MARGIN &&
           length <= this.container.dimensions.height;
  }

  /**
   * Generate horizontal positions (honeycomb in XZ plane)
   */
  private generateHorizontalPositions(
    radius: number,
    length: number,
    placed: PlacedCylinder[]
  ): Array<{ x: number; y: number; z: number }> {
    const positions: Array<{ x: number; y: number; z: number }> = [];
    const diameter = radius * 2;
    const rowHeight = radius * Math.sqrt(3); // Honeycomb vertical spacing

    // Collect all Y start positions to try
    const yStarts = new Set<number>();
    yStarts.add(this.WALL_MARGIN);

    // Add positions right after existing cylinders
    for (const p of placed) {
      if (p.orientation === 'horizontal-y') {
        const nextY = p.position.y + p.length + this.CYLINDER_GAP;
        if (nextY + length <= this.container.dimensions.length - this.WALL_MARGIN) {
          yStarts.add(nextY);
        }
      }
    }

    // Add positions aligned with existing cylinders
    for (const p of placed) {
      if (p.orientation === 'horizontal-y') {
        yStarts.add(p.position.y);
      }
    }

    for (const yStart of yStarts) {
      // Generate honeycomb grid in XZ
      for (let row = 0; row < 10; row++) {
        const z = row * rowHeight;
        if (z + diameter > this.container.dimensions.height) break;

        const xOffset = (row % 2 === 1) ? radius : 0;

        for (let x = this.WALL_MARGIN + radius + xOffset; x + radius <= this.container.dimensions.width - this.WALL_MARGIN; x += diameter + this.CYLINDER_GAP) {
          positions.push({ x, y: yStart, z });
        }
      }

      // Valley positions - nestle on top of two adjacent cylinders
      const sameYCylinders = placed.filter(
        p => p.orientation === 'horizontal-y' &&
             Math.abs(p.position.y - yStart) < length * 0.1
      );

      for (let i = 0; i < sameYCylinders.length; i++) {
        for (let j = i + 1; j < sameYCylinders.length; j++) {
          const p1 = sameYCylinders[i];
          const p2 = sameYCylinders[j];

          // Same Z level?
          if (Math.abs(p1.position.z - p2.position.z) > 1) continue;

          // Adjacent in X?
          const xDist = Math.abs(p1.center.x - p2.center.x);
          const touchDist = p1.radius + p2.radius + this.CYLINDER_GAP;

          if (xDist >= touchDist - 1 && xDist <= touchDist + diameter) {
            // Calculate valley position
            const midX = (p1.center.x + p2.center.x) / 2;
            const baseZ = p1.position.z;
            const supportRadius = Math.min(p1.radius, p2.radius);
            const valleyZ = baseZ + supportRadius * Math.sqrt(3);

            if (valleyZ + diameter <= this.container.dimensions.height) {
              positions.push({ x: midX, y: yStart, z: valleyZ });
            }
          }
        }
      }
    }

    return positions;
  }

  /**
   * Generate vertical positions (hexagonal in XY plane, stack in Z)
   */
  private generateVerticalPositions(
    radius: number,
    length: number,
    placed: PlacedCylinder[]
  ): Array<{ x: number; y: number; z: number }> {
    const positions: Array<{ x: number; y: number; z: number }> = [];
    const diameter = radius * 2;
    const rowSpacing = radius * Math.sqrt(3);

    // Hexagonal grid on floor
    for (let row = 0; row < 50; row++) {
      const y = this.WALL_MARGIN + radius + row * rowSpacing;
      if (y + radius > this.container.dimensions.length - this.WALL_MARGIN) break;

      const xOffset = (row % 2 === 1) ? radius : 0;

      for (let x = this.WALL_MARGIN + radius + xOffset; x + radius <= this.container.dimensions.width - this.WALL_MARGIN; x += diameter + this.CYLINDER_GAP) {
        // Stack vertically
        for (let z = 0; z + length <= this.container.dimensions.height; z += length + this.CYLINDER_GAP) {
          positions.push({ x, y, z });
        }
      }
    }

    // Stacking on existing vertical cylinders
    for (const p of placed) {
      if (p.orientation === 'vertical') {
        const stackZ = p.position.z + p.length + this.CYLINDER_GAP;
        if (stackZ + length <= this.container.dimensions.height) {
          positions.push({ x: p.center.x, y: p.center.y, z: stackZ });
        }
      }
    }

    return positions;
  }

  /**
   * Check if position is valid
   */
  private isValidPosition(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder[]
  ): boolean {
    // Bounds check
    if (!this.withinBounds(x, y, z, radius, length, orientation)) {
      return false;
    }

    // Collision check
    for (const p of placed) {
      if (this.collides(x, y, z, radius, length, orientation, p)) {
        return false;
      }
    }

    return true;
  }

  private withinBounds(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation
  ): boolean {
    const m = this.WALL_MARGIN;
    const { width, length: containerLength, height } = this.container.dimensions;
    const d = radius * 2;

    if (orientation === 'horizontal-y') {
      return x - radius >= m && x + radius <= width - m &&
             y >= m && y + length <= containerLength - m &&
             z >= 0 && z + d <= height;
    } else {
      return x - radius >= m && x + radius <= width - m &&
             y - radius >= m && y + radius <= containerLength - m &&
             z >= 0 && z + length <= height;
    }
  }

  /**
   * Precise collision detection
   */
  private collides(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    other: PlacedCylinder
  ): boolean {
    const gap = this.CYLINDER_GAP;
    const minDist = radius + other.radius + gap;

    if (orientation === 'horizontal-y' && other.orientation === 'horizontal-y') {
      // Both horizontal - check Y overlap then XZ circle distance
      const y1End = y + length;
      const y2End = other.position.y + other.length;

      if (y1End <= other.position.y || y >= y2End) return false;

      const c1z = z + radius;
      const c2z = other.position.z + other.radius;
      const dist = Math.sqrt((x - other.center.x) ** 2 + (c1z - c2z) ** 2);
      return dist < minDist;

    } else if (orientation === 'vertical' && other.orientation === 'vertical') {
      // Both vertical - check Z overlap then XY circle distance
      const z1End = z + length;
      const z2End = other.position.z + other.length;

      if (z1End <= other.position.z || z >= z2End) return false;

      const dist = Math.sqrt((x - other.center.x) ** 2 + (y - other.center.y) ** 2);
      return dist < minDist;

    } else {
      // Mixed - use AABB
      const bb1 = this.getBB(x, y, z, radius, length, orientation);
      const bb2 = this.getPlacedBB(other);

      return !(bb1.maxX <= bb2.minX + gap || bb1.minX >= bb2.maxX - gap ||
               bb1.maxY <= bb2.minY + gap || bb1.minY >= bb2.maxY - gap ||
               bb1.maxZ <= bb2.minZ + gap || bb1.minZ >= bb2.maxZ - gap);
    }
  }

  private getBB(x: number, y: number, z: number, r: number, len: number, orient: CylinderOrientation) {
    const d = r * 2;
    if (orient === 'horizontal-y') {
      return { minX: x - r, maxX: x + r, minY: y, maxY: y + len, minZ: z, maxZ: z + d };
    } else {
      return { minX: x - r, maxX: x + r, minY: y - r, maxY: y + r, minZ: z, maxZ: z + len };
    }
  }

  private getPlacedBB(p: PlacedCylinder) {
    const d = p.radius * 2;
    if (p.orientation === 'horizontal-y') {
      return {
        minX: p.center.x - p.radius, maxX: p.center.x + p.radius,
        minY: p.position.y, maxY: p.position.y + p.length,
        minZ: p.position.z, maxZ: p.position.z + d,
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
   * Score position - lower is better
   * Prioritizes: filling from back (Y), bottom (Z), and tight packing
   */
  private scorePosition(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder[]
  ): number {
    const { width, length: containerLength, height } = this.container.dimensions;

    // Base score: prioritize back, bottom, left
    let score = (y / containerLength) * 10000 + (z / height) * 1000 + (x / width) * 100;

    // Bonus for touching existing cylinders (tighter packing)
    let touchCount = 0;
    for (const p of placed) {
      if (this.isTouching(x, y, z, radius, length, orientation, p)) {
        touchCount++;
      }
    }
    score -= touchCount * 50; // Reward touching other cylinders

    // Bonus for being on the floor
    if (z < 1) score -= 200;

    return score;
  }

  /**
   * Check if new cylinder would touch an existing one
   */
  private isTouching(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    other: PlacedCylinder
  ): boolean {
    const touchDist = radius + other.radius + this.CYLINDER_GAP * 2;

    if (orientation === 'horizontal-y' && other.orientation === 'horizontal-y') {
      // Check Y overlap
      const y1End = y + length;
      const y2End = other.position.y + other.length;
      if (y1End < other.position.y || y > y2End) return false;

      const c1z = z + radius;
      const c2z = other.position.z + other.radius;
      const dist = Math.sqrt((x - other.center.x) ** 2 + (c1z - c2z) ** 2);
      return dist < touchDist && dist > radius + other.radius - 1;
    }

    return false;
  }

  private createPlacedCylinder(
    item: CargoItem,
    pos: CandidatePosition,
    radius: number,
    length: number
  ): PlacedCylinder {
    let cornerPos: { x: number; y: number; z: number };
    let centerPos: { x: number; y: number; z: number };

    if (pos.orientation === 'horizontal-y') {
      cornerPos = { x: pos.x - radius, y: pos.y, z: pos.z };
      centerPos = { x: pos.x, y: pos.y + length / 2, z: pos.z + radius };
    } else {
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
  private sortByDiameter(items: CargoItem[], desc: boolean): CargoItem[] {
    return [...items].sort((a, b) => desc ? b.dimensions.width - a.dimensions.width : a.dimensions.width - b.dimensions.width);
  }

  private sortByVolume(items: CargoItem[], desc: boolean): CargoItem[] {
    const vol = (i: CargoItem) => Math.PI * (i.dimensions.width / 2) ** 2 * i.dimensions.height;
    return [...items].sort((a, b) => desc ? vol(b) - vol(a) : vol(a) - vol(b));
  }

  private sortByLength(items: CargoItem[], desc: boolean): CargoItem[] {
    return [...items].sort((a, b) => desc ? b.dimensions.height - a.dimensions.height : a.dimensions.height - b.dimensions.height);
  }

  private sortMixed(items: CargoItem[]): CargoItem[] {
    return [...items].sort((a, b) => {
      const dA = a.dimensions.width, dB = b.dimensions.width;
      if (Math.abs(dA - dB) > 5) return dB - dA;
      return b.dimensions.height - a.dimensions.height;
    });
  }

  private calculateEfficiency(placed: PlacedCylinder[]): number {
    if (placed.length === 0) return 0;

    let totalVol = 0;
    let maxX = 0, maxY = 0, maxZ = 0;

    for (const c of placed) {
      totalVol += Math.PI * c.radius ** 2 * c.length;
      const bb = this.getPlacedBB(c);
      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
      maxZ = Math.max(maxZ, bb.maxZ);
    }

    return totalVol / (maxX * maxY * maxZ);
  }

  private calculateStatistics(placed: PlacedCylinder[], failed: number): PackingStatistics {
    const efficiency = this.calculateEfficiency(placed);
    let totalVol = 0, maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius ** 2 * c.length;
      layers.add(c.layerId);
      const bb = this.getPlacedBB(c);
      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
      maxZ = Math.max(maxZ, bb.maxZ);
    }

    return {
      totalVolumePlaced: totalVol,
      containerVolumeUsed: maxX * maxY * maxZ,
      volumeEfficiency: efficiency,
      layerCount: layers.size,
      itemsPlaced: placed.length,
      itemsFailed: failed,
    };
  }

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
