// src/core/solvers/coil-solver/coil-solver.ts

import type { Container, CargoItem, PlacedItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
} from './types';
import {
  DEFAULT_COIL_SOLVER_CONFIG,
  getAllowedOrientations,
  ORIENTATION_ROTATIONS,
} from './types';
import { VerticalStacker } from './vertical-stacker';
import { HorizontalStacker } from './horizontal-stacker';
import { ValleyManager } from './valley-manager';

/**
 * Strategy for deciding cylinder orientation
 */
export type OrientationStrategy =
  | 'vertical-only' // Only use vertical (upright) placement
  | 'horizontal-only' // Only use horizontal (lying) placement
  | 'best-fit' // Try both and choose best for each item
  | 'layer-based'; // Place in layers, alternating orientation for efficiency

/**
 * CoilSolver is the main orchestrator for cylinder/coil packing.
 *
 * It coordinates between vertical and horizontal stackers to find
 * the optimal arrangement of cylindrical items in a container.
 *
 * Key Features:
 * - Supports multiple orientation strategies
 * - Handles mixed-size cylinders with nesting optimization
 * - Provides volume efficiency statistics
 * - Follows SOLID principles with clear separation of concerns
 *
 * Usage:
 * ```typescript
 * const solver = new CoilSolver(container);
 * const result = solver.solve(items);
 * console.log(`Placed ${result.placedCylinders.length} cylinders`);
 * console.log(`Efficiency: ${result.statistics.volumeEfficiency * 100}%`);
 * ```
 */
export class CoilSolver {
  private container: Container;
  private config: CoilSolverConfig;
  private strategy: OrientationStrategy;

  constructor(
    container: Container,
    config: Partial<CoilSolverConfig> = {},
    strategy: OrientationStrategy = 'best-fit'
  ) {
    this.container = container;
    this.config = { ...DEFAULT_COIL_SOLVER_CONFIG, ...config };
    this.strategy = strategy;
  }

  /**
   * Solve the coil packing problem for the given items.
   * Returns detailed results including placed cylinders and statistics.
   */
  public solve(items: CargoItem[]): CoilSolverResult {
    // Filter to only cylinder items
    const cylinderItems = items.filter((item) => item.type === 'cylinder');

    if (cylinderItems.length === 0) {
      return this.emptyResult();
    }

    switch (this.strategy) {
      case 'vertical-only':
        return this.solveVerticalOnly(cylinderItems);
      case 'horizontal-only':
        return this.solveHorizontalOnly(cylinderItems);
      case 'best-fit':
        return this.solveBestFit(cylinderItems);
      case 'layer-based':
        return this.solveLayerBased(cylinderItems);
      default:
        return this.solveBestFit(cylinderItems);
    }
  }

  /**
   * Solve using only vertical (upright) placement
   */
  private solveVerticalOnly(items: CargoItem[]): CoilSolverResult {
    const stacker = new VerticalStacker(this.container, this.config);
    const { placed, unplaced } = stacker.solve(items);

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calculateStatistics(placed, unplaced.length),
    };
  }

  /**
   * Solve using only horizontal (lying) placement
   */
  private solveHorizontalOnly(items: CargoItem[]): CoilSolverResult {
    const stacker = new HorizontalStacker(this.container, this.config);
    const { placed, unplaced } = stacker.solve(items);

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calculateStatistics(placed, unplaced.length),
    };
  }

  /**
   * Solve by trying both orientations and picking the best for each item
   *
   * This is a greedy approach that considers both vertical and horizontal
   * placement for each item and chooses the one with the better score.
   */
  private solveBestFit(items: CargoItem[]): CoilSolverResult {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    // Create managers for both orientations
    const verticalManager = new ValleyManager(this.container, this.config);
    const horizontalManager = new ValleyManager(this.container, this.config);

    // Sort items by volume (largest first)
    const sortedItems = this.sortByVolume(items);

    // Flatten quantity
    const queue: CargoItem[] = [];
    for (const item of sortedItems) {
      for (let i = 0; i < item.quantity; i++) {
        queue.push({ ...item, quantity: 1 });
      }
    }

    // Process each item
    for (const item of queue) {
      const allowedOrientations = getAllowedOrientations(item);
      const radius = item.dimensions.width / 2;
      const length = item.dimensions.height;

      let bestPlacement: {
        position: { x: number; y: number; z: number };
        center: { x: number; y: number; z: number };
        orientation: 'vertical' | 'horizontal-y';
        score: number;
        supportingIds: string[];
        manager: ValleyManager;
      } | null = null;

      // Try vertical placement
      if (allowedOrientations.includes('vertical')) {
        const vertCandidates = [
          ...verticalManager.findFloorPositions(radius, length, 'vertical'),
          ...verticalManager.findStackingPositions(radius, length, 'vertical'),
          ...verticalManager.findValleyPositions(radius, length, false),
        ];

        for (const candidate of vertCandidates) {
          if (!bestPlacement || candidate.score < bestPlacement.score) {
            bestPlacement = {
              position: candidate.position,
              center: candidate.center,
              orientation: 'vertical',
              score: candidate.score,
              supportingIds: candidate.supportingIds,
              manager: verticalManager,
            };
          }
        }
      }

      // Try horizontal placement
      if (allowedOrientations.includes('horizontal-y')) {
        const horizCandidates = [
          ...horizontalManager.findFloorPositions(radius, length, 'horizontal-y'),
          ...horizontalManager.findStackingPositions(radius, length, 'horizontal-y'),
          ...horizontalManager.findValleyPositions(radius, length, true),
        ];

        for (const candidate of horizCandidates) {
          // Adjust score slightly to prefer horizontal for long cylinders
          let adjustedScore = candidate.score;
          if (length > radius * 4) {
            adjustedScore -= this.config.heightWeight * 0.5; // Bonus for horizontal
          }

          if (!bestPlacement || adjustedScore < bestPlacement.score) {
            bestPlacement = {
              position: candidate.position,
              center: candidate.center,
              orientation: 'horizontal-y',
              score: adjustedScore,
              supportingIds: candidate.supportingIds,
              manager: horizontalManager,
            };
          }
        }
      }

      if (bestPlacement) {
        const cylinder: PlacedCylinder = {
          item,
          uniqueId: `${item.id}_${bestPlacement.orientation[0]}_${Math.random().toString(36).substr(2, 6)}`,
          position: bestPlacement.position,
          center: bestPlacement.center,
          radius,
          length,
          orientation: bestPlacement.orientation,
          rotation: ORIENTATION_ROTATIONS[bestPlacement.orientation],
          layerId: 0, // Will be updated
          supportedBy: bestPlacement.supportingIds,
        };

        placed.push(cylinder);

        // Add to BOTH managers to maintain consistent collision detection
        verticalManager.addCylinder(cylinder);
        horizontalManager.addCylinder(cylinder);
      } else {
        unplaced.push(item);
      }
    }

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calculateStatistics(placed, unplaced.length),
    };
  }

  /**
   * Solve using a layer-based approach
   *
   * This strategy fills the container in Y-slices:
   * 1. Determine optimal orientation for the first layer
   * 2. Fill that layer completely
   * 3. Move to next Y position and repeat
   *
   * This can be more efficient for uniform cylinder sizes.
   */
  private solveLayerBased(items: CargoItem[]): CoilSolverResult {
    const placed: PlacedCylinder[] = [];
    const unplaced: CargoItem[] = [];

    // Sort items by volume
    const sortedItems = this.sortByVolume(items);

    // Flatten quantity
    const queue: CargoItem[] = [];
    for (const item of sortedItems) {
      for (let i = 0; i < item.quantity; i++) {
        queue.push({ ...item, quantity: 1 });
      }
    }

    // Determine dominant orientation based on cylinder dimensions
    const dominantOrientation = this.determineDominantOrientation(queue);

    if (dominantOrientation === 'vertical') {
      // Use vertical stacker
      const stacker = new VerticalStacker(this.container, this.config);
      const result = stacker.solve(queue);
      placed.push(...result.placed);
      unplaced.push(...result.unplaced);
    } else {
      // Use horizontal stacker
      const stacker = new HorizontalStacker(this.container, this.config);
      const result = stacker.solve(queue);
      placed.push(...result.placed);
      unplaced.push(...result.unplaced);
    }

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calculateStatistics(placed, unplaced.length),
    };
  }

  /**
   * Determine the dominant orientation based on item characteristics
   */
  private determineDominantOrientation(
    items: CargoItem[]
  ): 'vertical' | 'horizontal' {
    let verticalScore = 0;
    let horizontalScore = 0;

    for (const item of items) {
      const radius = item.dimensions.width / 2;
      const length = item.dimensions.height;
      const aspectRatio = length / (radius * 2);

      // Short, wide cylinders prefer vertical (like coins)
      if (aspectRatio < 1) {
        verticalScore += item.quantity;
      }
      // Long cylinders prefer horizontal (like logs)
      else if (aspectRatio > 2) {
        horizontalScore += item.quantity;
      }
      // Medium cylinders - check container fit
      else {
        // If cylinder length exceeds container height, must be horizontal
        if (length > this.container.dimensions.height) {
          horizontalScore += item.quantity * 2;
        } else {
          // Slight preference for vertical for medium cylinders
          verticalScore += item.quantity * 0.5;
        }
      }
    }

    // Apply configuration preference
    if (this.config.preferVertical) {
      verticalScore *= 1.2;
    }

    return verticalScore >= horizontalScore ? 'vertical' : 'horizontal';
  }

  /**
   * Sort items by volume (largest first)
   */
  private sortByVolume(items: CargoItem[]): CargoItem[] {
    return [...items].sort((a, b) => {
      const volA =
        Math.PI * Math.pow(a.dimensions.width / 2, 2) * a.dimensions.height;
      const volB =
        Math.PI * Math.pow(b.dimensions.width / 2, 2) * b.dimensions.height;
      return volB - volA;
    });
  }

  /**
   * Calculate packing statistics
   */
  private calculateStatistics(
    placed: PlacedCylinder[],
    failedCount: number
  ): PackingStatistics {
    if (placed.length === 0) {
      return {
        totalVolumePlaced: 0,
        containerVolumeUsed: 0,
        volumeEfficiency: 0,
        layerCount: 0,
        itemsPlaced: 0,
        itemsFailed: failedCount,
      };
    }

    let totalVolume = 0;
    let maxX = 0,
      maxY = 0,
      maxZ = 0;
    const layerIds = new Set<number>();

    for (const cyl of placed) {
      totalVolume += Math.PI * cyl.radius * cyl.radius * cyl.length;
      layerIds.add(cyl.layerId);

      // Calculate bounding box
      let dims: { x: number; y: number; z: number };
      switch (cyl.orientation) {
        case 'vertical':
          dims = { x: cyl.radius * 2, y: cyl.radius * 2, z: cyl.length };
          break;
        case 'horizontal-y':
          dims = { x: cyl.radius * 2, y: cyl.length, z: cyl.radius * 2 };
          break;
        case 'horizontal-x':
          dims = { x: cyl.length, y: cyl.radius * 2, z: cyl.radius * 2 };
          break;
      }

      maxX = Math.max(maxX, cyl.position.x + dims.x);
      maxY = Math.max(maxY, cyl.position.y + dims.y);
      maxZ = Math.max(maxZ, cyl.position.z + dims.z);
    }

    const boundingVolume = maxX * maxY * maxZ;

    return {
      totalVolumePlaced: totalVolume,
      containerVolumeUsed: boundingVolume,
      volumeEfficiency: boundingVolume > 0 ? totalVolume / boundingVolume : 0,
      layerCount: layerIds.size,
      itemsPlaced: placed.length,
      itemsFailed: failedCount,
    };
  }

  /**
   * Create empty result
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

  /**
   * Convert PlacedCylinder to PlacedItem for compatibility with existing code
   */
  public static toPlacedItem(cylinder: PlacedCylinder): PlacedItem {
    return {
      ...cylinder.item,
      uniqueId: cylinder.uniqueId,
      position: cylinder.position,
      rotation: cylinder.rotation,
      layerId: cylinder.layerId,
    };
  }

  /**
   * Convert array of PlacedCylinder to PlacedItem[]
   */
  public static toPlacedItems(cylinders: PlacedCylinder[]): PlacedItem[] {
    return cylinders.map((cyl) => this.toPlacedItem(cyl));
  }
}
