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
 * Sorting strategy for items
 */
type SortStrategy =
  | 'volume-desc'      // Largest volume first
  | 'volume-asc'       // Smallest volume first
  | 'diameter-desc'    // Largest diameter first
  | 'diameter-asc'     // Smallest diameter first
  | 'length-desc'      // Longest first
  | 'length-asc'       // Shortest first
  | 'aspect-ratio-desc' // Highest aspect ratio (length/diameter) first
  | 'aspect-ratio-asc'; // Lowest aspect ratio first

/**
 * Orientation strategy
 */
type OrientationMode = 'horizontal' | 'vertical' | 'mixed-prefer-horizontal' | 'mixed-prefer-vertical';

/**
 * A placement attempt result
 */
interface PlacementAttempt {
  sortStrategy: SortStrategy;
  orientationMode: OrientationMode;
  placed: PlacedCylinder[];
  unplaced: CargoItem[];
  score: number;
}

/**
 * OptimizedCoilSolver uses multiple strategies and picks the best result.
 *
 * This solver:
 * 1. Tries 8 different sorting strategies
 * 2. Tries 4 different orientation modes
 * 3. Runs 32 total placement attempts
 * 4. Returns the best result (most items placed, highest efficiency)
 *
 * For each attempt, it uses a greedy bin-packing algorithm with:
 * - Systematic position generation (honeycomb for horizontal, grid for vertical)
 * - Collision detection using precise circular geometry
 * - Score-based position selection (prioritize filling back, bottom, left)
 */
export class OptimizedCoilSolver {
  private container: Container;
  private config: CoilSolverConfig;

  constructor(container: Container, config: Partial<CoilSolverConfig> = {}) {
    this.container = container;
    this.config = { ...DEFAULT_COIL_SOLVER_CONFIG, ...config };
  }

  /**
   * Solve with optimization - tries multiple strategies
   */
  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinderItems = items.filter((item) => item.type === 'cylinder');

    if (cylinderItems.length === 0) {
      return this.emptyResult();
    }

    // Flatten items (expand quantities)
    const flatItems: CargoItem[] = [];
    for (const item of cylinderItems) {
      for (let i = 0; i < item.quantity; i++) {
        flatItems.push({ ...item, quantity: 1 });
      }
    }

    const totalItems = flatItems.length;

    // Try all combinations of strategies
    const sortStrategies: SortStrategy[] = [
      'volume-desc',
      'diameter-desc',
      'length-desc',
      'aspect-ratio-desc',
      'volume-asc',
      'diameter-asc',
      'length-asc',
      'aspect-ratio-asc',
    ];

    const orientationModes: OrientationMode[] = [
      'horizontal',
      'vertical',
      'mixed-prefer-horizontal',
      'mixed-prefer-vertical',
    ];

    const attempts: PlacementAttempt[] = [];

    // Run all strategy combinations
    for (const sortStrategy of sortStrategies) {
      for (const orientationMode of orientationModes) {
        const sortedItems = this.sortItems([...flatItems], sortStrategy);
        const result = this.runPlacement(sortedItems, orientationMode);

        // Calculate score: prioritize placing all items, then efficiency
        const placedRatio = result.placed.length / totalItems;
        const efficiency = this.calculateEfficiency(result.placed);
        const score = placedRatio * 1000 + efficiency * 100;

        attempts.push({
          sortStrategy,
          orientationMode,
          placed: result.placed,
          unplaced: result.unplaced,
          score,
        });

        // Early exit if we placed everything
        if (result.placed.length === totalItems) {
          console.log(`✓ Perfect fit found: ${sortStrategy} + ${orientationMode}`);
        }
      }
    }

    // Find best attempt
    attempts.sort((a, b) => b.score - a.score);
    const best = attempts[0];

    console.log(`Best strategy: ${best.sortStrategy} + ${best.orientationMode}`);
    console.log(`Placed: ${best.placed.length}/${totalItems}, Efficiency: ${(this.calculateEfficiency(best.placed) * 100).toFixed(1)}%`);

    return {
      placedCylinders: best.placed,
      unplacedItems: best.unplaced,
      statistics: this.calculateStatistics(best.placed, best.unplaced.length),
    };
  }

  /**
   * Sort items according to strategy
   */
  private sortItems(items: CargoItem[], strategy: SortStrategy): CargoItem[] {
    return items.sort((a, b) => {
      const radiusA = a.dimensions.width / 2;
      const radiusB = b.dimensions.width / 2;
      const lengthA = a.dimensions.height;
      const lengthB = b.dimensions.height;
      const volumeA = Math.PI * radiusA * radiusA * lengthA;
      const volumeB = Math.PI * radiusB * radiusB * lengthB;
      const aspectA = lengthA / (radiusA * 2);
      const aspectB = lengthB / (radiusB * 2);

      switch (strategy) {
        case 'volume-desc': return volumeB - volumeA;
        case 'volume-asc': return volumeA - volumeB;
        case 'diameter-desc': return radiusB - radiusA;
        case 'diameter-asc': return radiusA - radiusB;
        case 'length-desc': return lengthB - lengthA;
        case 'length-asc': return lengthA - lengthB;
        case 'aspect-ratio-desc': return aspectB - aspectA;
        case 'aspect-ratio-asc': return aspectA - aspectB;
        default: return 0;
      }
    });
  }

  /**
   * Run placement with a specific orientation mode
   */
  private runPlacement(
    items: CargoItem[],
    mode: OrientationMode
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    for (const item of items) {
      const radius = item.dimensions.width / 2;
      const length = item.dimensions.height;

      // Determine which orientations to try based on mode
      const orientationsToTry = this.getOrientationsForMode(mode, radius, length);

      let bestPosition: {
        x: number;
        y: number;
        z: number;
        orientation: CylinderOrientation;
        score: number;
      } | null = null;

      // Try each orientation
      for (const orientation of orientationsToTry) {
        const positions = this.generatePositions(radius, length, orientation, placed);

        for (const pos of positions) {
          if (!this.hasCollision(pos.x, pos.y, pos.z, radius, length, orientation, placed)) {
            const score = this.calculatePositionScore(pos, orientation);
            if (!bestPosition || score < bestPosition.score) {
              bestPosition = { ...pos, orientation, score };
            }
          }
        }
      }

      if (bestPosition) {
        placed.push(this.createCylinder(item, bestPosition, radius, length));
      } else {
        unplaced.push(item);
      }
    }

    return { placed, unplaced };
  }

  /**
   * Get orientations to try based on mode
   */
  private getOrientationsForMode(
    mode: OrientationMode,
    radius: number,
    length: number
  ): CylinderOrientation[] {
    const diameter = radius * 2;
    const aspectRatio = length / diameter;

    switch (mode) {
      case 'horizontal':
        return ['horizontal-y'];
      case 'vertical':
        // Only vertical if it fits in container height
        if (length <= this.container.dimensions.height) {
          return ['vertical'];
        }
        return ['horizontal-y']; // Fallback to horizontal
      case 'mixed-prefer-horizontal':
        // Try horizontal first, then vertical
        if (length <= this.container.dimensions.height) {
          return ['horizontal-y', 'vertical'];
        }
        return ['horizontal-y'];
      case 'mixed-prefer-vertical':
        // Try vertical first if aspect ratio is low (short cylinders)
        if (length <= this.container.dimensions.height) {
          if (aspectRatio < 1.5) {
            return ['vertical', 'horizontal-y'];
          }
          return ['horizontal-y', 'vertical'];
        }
        return ['horizontal-y'];
      default:
        return ['horizontal-y'];
    }
  }

  /**
   * Generate candidate positions for a cylinder
   */
  private generatePositions(
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    _placed: PlacedCylinder[]
  ): Array<{ x: number; y: number; z: number }> {
    const positions: Array<{ x: number; y: number; z: number }> = [];
    const margin = this.config.wallMargin;
    const diameter = radius * 2;

    if (orientation === 'horizontal-y') {
      // Honeycomb positions for horizontal placement
      const rowHeight = radius * Math.sqrt(3);
      const yStep = Math.min(length, 50); // Finer Y-step for better packing

      for (let y = margin; y + length <= this.container.dimensions.length - margin; y += yStep) {
        let row = 0;
        let z = 0;

        while (z + diameter <= this.container.dimensions.height) {
          const isOddRow = row % 2 === 1;
          const xOffset = isOddRow ? radius : 0;

          let x = margin + radius + xOffset;
          while (x + radius <= this.container.dimensions.width - margin) {
            positions.push({ x, y, z });
            x += diameter;
          }

          row++;
          z += rowHeight;
        }
      }
    } else if (orientation === 'vertical') {
      // Grid positions for vertical placement (hexagonal in XY plane)
      const rowSpacing = radius * Math.sqrt(3);

      let rowNum = 0;
      let y = margin + radius;

      while (y + radius <= this.container.dimensions.length - margin) {
        const isOddRow = rowNum % 2 === 1;
        const xOffset = isOddRow ? radius : 0;

        let x = margin + radius + xOffset;
        while (x + radius <= this.container.dimensions.width - margin) {
          // Stack vertically
          let z = 0;
          while (z + length <= this.container.dimensions.height) {
            positions.push({ x, y, z });
            z += length; // Stack directly on top
          }
          x += diameter;
        }

        y += rowSpacing;
        rowNum++;
      }
    }

    return positions;
  }

  /**
   * Check collision with placed cylinders
   */
  private hasCollision(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder[]
  ): boolean {
    const margin = this.config.cylinderMargin;

    for (const p of placed) {
      if (this.cylindersOverlap(x, y, z, radius, length, orientation, p, margin)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Check if two cylinders overlap
   */
  private cylindersOverlap(
    x: number,
    y: number,
    z: number,
    radius: number,
    length: number,
    orientation: CylinderOrientation,
    placed: PlacedCylinder,
    margin: number
  ): boolean {
    // Get bounding boxes
    const bb1 = this.getBoundingBox(x, y, z, radius, length, orientation);
    const bb2 = this.getBoundingBox(
      placed.center.x,
      placed.center.y,
      placed.position.z,
      placed.radius,
      placed.length,
      placed.orientation
    );

    // Quick AABB check
    if (
      bb1.maxX <= bb2.minX + margin ||
      bb1.minX >= bb2.maxX - margin ||
      bb1.maxY <= bb2.minY + margin ||
      bb1.minY >= bb2.maxY - margin ||
      bb1.maxZ <= bb2.minZ + margin ||
      bb1.minZ >= bb2.maxZ - margin
    ) {
      return false;
    }

    // Precise check for same orientation
    if (orientation === placed.orientation) {
      if (orientation === 'horizontal-y') {
        // Check Y overlap
        const y1Min = y;
        const y1Max = y + length;
        const y2Min = placed.position.y;
        const y2Max = placed.position.y + placed.length;

        if (y1Max <= y2Min + margin || y1Min >= y2Max - margin) {
          return false;
        }

        // Circle overlap in XZ
        const c1z = z + radius;
        const c2z = placed.position.z + placed.radius;
        const dist = Math.sqrt(Math.pow(x - placed.center.x, 2) + Math.pow(c1z - c2z, 2));
        return dist < radius + placed.radius - margin;
      } else if (orientation === 'vertical') {
        // Check Z overlap
        const z1Max = z + length;
        const z2Max = placed.position.z + placed.length;

        if (z1Max <= placed.position.z + margin || z >= z2Max - margin) {
          return false;
        }

        // Circle overlap in XY
        const dist = Math.sqrt(Math.pow(x - placed.center.x, 2) + Math.pow(y - placed.center.y, 2));
        return dist < radius + placed.radius - margin;
      }
    }

    // Different orientations - AABB already confirmed overlap
    return true;
  }

  /**
   * Get bounding box for a cylinder
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

    switch (orientation) {
      case 'horizontal-y':
        return {
          minX: x - radius,
          maxX: x + radius,
          minY: y,
          maxY: y + length,
          minZ: z,
          maxZ: z + diameter,
        };
      case 'vertical':
        return {
          minX: x - radius,
          maxX: x + radius,
          minY: y - radius,
          maxY: y + radius,
          minZ: z,
          maxZ: z + length,
        };
      case 'horizontal-x':
        return {
          minX: x - length / 2,
          maxX: x + length / 2,
          minY: y - radius,
          maxY: y + radius,
          minZ: z,
          maxZ: z + diameter,
        };
    }
  }

  /**
   * Calculate position score (lower is better)
   */
  private calculatePositionScore(
    pos: { x: number; y: number; z: number },
    _orientation: CylinderOrientation
  ): number {
    // Prioritize: back of container (Y) -> bottom (Z) -> left (X)
    return pos.y * 100000 + pos.z * 1000 + pos.x;
  }

  /**
   * Create a placed cylinder
   */
  private createCylinder(
    item: CargoItem,
    pos: { x: number; y: number; z: number; orientation: CylinderOrientation },
    radius: number,
    length: number
  ): PlacedCylinder {
    let cornerPos: { x: number; y: number; z: number };
    let centerPos: { x: number; y: number; z: number };

    if (pos.orientation === 'horizontal-y') {
      cornerPos = { x: pos.x - radius, y: pos.y, z: pos.z };
      centerPos = { x: pos.x, y: pos.y + length / 2, z: pos.z };
    } else if (pos.orientation === 'vertical') {
      cornerPos = { x: pos.x - radius, y: pos.y - radius, z: pos.z };
      centerPos = { x: pos.x, y: pos.y, z: pos.z };
    } else {
      cornerPos = { x: pos.x - length / 2, y: pos.y - radius, z: pos.z };
      centerPos = { x: pos.x, y: pos.y, z: pos.z };
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

  /**
   * Calculate volume efficiency
   */
  private calculateEfficiency(placed: PlacedCylinder[]): number {
    if (placed.length === 0) return 0;

    let totalVolume = 0;
    let maxX = 0, maxY = 0, maxZ = 0;

    for (const cyl of placed) {
      totalVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;

      const bb = this.getBoundingBox(
        cyl.center.x,
        cyl.orientation === 'horizontal-y' ? cyl.position.y : cyl.center.y,
        cyl.position.z,
        cyl.radius,
        cyl.length,
        cyl.orientation
      );

      maxX = Math.max(maxX, bb.maxX);
      maxY = Math.max(maxY, bb.maxY);
      maxZ = Math.max(maxZ, bb.maxZ);
    }

    const boundingVolume = maxX * maxY * maxZ;
    return boundingVolume > 0 ? totalVolume / boundingVolume : 0;
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

      const bb = this.getBoundingBox(
        cyl.center.x,
        cyl.orientation === 'horizontal-y' ? cyl.position.y : cyl.center.y,
        cyl.position.z,
        cyl.radius,
        cyl.length,
        cyl.orientation
      );

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
