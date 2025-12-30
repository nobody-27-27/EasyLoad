// src/core/solvers/mixed-solver/orchestrator.ts

import type { Container, CargoItem, PlacedItem } from '../../common/types';
import { WallBuilder } from '../box-solver/wall-builder';
import { OptimizedCoilSolver } from '../coil-solver';

/**
 * Configuration for the MixedSolver
 */
export interface MixedSolverConfig {
  useOptimizedSolver: boolean; // Use the multi-strategy optimizer
  enableMixedStacking: boolean; // Allow boxes on top of coils
}

/**
 * MixedSolver orchestrates the placement of different cargo types
 * in a container, handling coils/cylinders, boxes, and pallets.
 *
 * Strategy:
 * 1. Place coils first (they're harder to pack efficiently)
 * 2. Place boxes in remaining space
 * 3. Optionally stack boxes on stable coil surfaces
 */
export class MixedSolver {
  private container: Container;

  constructor(container: Container, _config: Partial<MixedSolverConfig> = {}) {
    this.container = container;
  }

  public solve(items: CargoItem[]): PlacedItem[] {
    const placedItems: PlacedItem[] = [];

    // 1. Separate items by type
    const coils: CargoItem[] = [];
    const boxes: CargoItem[] = [];
    const pallets: CargoItem[] = [];

    items.forEach((item) => {
      switch (item.type) {
        case 'cylinder':
          coils.push(item);
          break;
        case 'pallet':
          pallets.push(item);
          break;
        default:
          boxes.push(item);
      }
    });

    // 2. Solve COILS using the OptimizedCoilSolver (tries 32 strategy combinations)
    if (coils.length > 0) {
      const coilSolver = new OptimizedCoilSolver(this.container);
      const coilResult = coilSolver.solve(coils);

      // Convert PlacedCylinder to PlacedItem
      const coilPlacedItems = coilResult.placedCylinders.map((cyl) => ({
        ...cyl.item,
        uniqueId: cyl.uniqueId,
        position: cyl.position,
        rotation: cyl.rotation,
        layerId: cyl.layerId,
      }));
      placedItems.push(...coilPlacedItems);

      // Log statistics
      console.log('Optimized Coil Solver Statistics:', {
        placed: coilResult.statistics.itemsPlaced,
        failed: coilResult.statistics.itemsFailed,
        efficiency: `${(coilResult.statistics.volumeEfficiency * 100).toFixed(1)}%`,
        layers: coilResult.statistics.layerCount,
      });

      // Warn about unplaced coils
      if (coilResult.unplacedItems.length > 0) {
        console.warn(
          `Could not place ${coilResult.unplacedItems.length} coil(s):`,
          coilResult.unplacedItems.map((i) => i.name)
        );
      }
    }

    // 3. Calculate remaining space for BOXES
    // Find the maximum Y extent used by coils
    let maxUsedY = 0;
    placedItems.forEach((item) => {
      // Calculate Y extent based on orientation
      let ySize: number;

      if (item.type === 'cylinder') {
        // Check rotation to determine orientation
        if (Math.abs(item.rotation.x) > 0.1) {
          // Horizontal-Y: Y = length (height in original dimensions)
          ySize = item.dimensions.height;
        } else if (Math.abs(item.rotation.z) > 0.1) {
          // Horizontal-X: Y = diameter
          ySize = item.dimensions.width;
        } else {
          // Vertical: Y = diameter
          ySize = item.dimensions.width;
        }
      } else {
        ySize = item.dimensions.length;
      }

      if (item.position.y + ySize > maxUsedY) {
        maxUsedY = item.position.y + ySize;
      }
    });

    // 4. Solve BOXES in remaining space
    if (boxes.length > 0) {
      const remainingLength = this.container.dimensions.length - maxUsedY;

      if (remainingLength > 1) {
        // Create virtual container for remaining space
        const virtualContainer: Container = {
          ...this.container,
          dimensions: {
            ...this.container.dimensions,
            length: remainingLength,
          },
        };

        const boxSolver = new WallBuilder(virtualContainer, boxes);
        const boxResults = boxSolver.solve();

        // Offset box positions to account for coil space
        boxResults.forEach((item) => {
          item.position.y += maxUsedY;
          placedItems.push(item);
        });
      } else {
        console.warn('No remaining space for boxes after coil placement');
      }
    }

    // 5. Handle PALLETS (similar to boxes for now)
    if (pallets.length > 0) {
      // Pallets are typically placed on the floor, before other items
      // For now, treat them like boxes
      // TODO: Implement dedicated pallet solver
      const remainingLength = this.container.dimensions.length - maxUsedY;

      if (remainingLength > 1) {
        const virtualContainer: Container = {
          ...this.container,
          dimensions: {
            ...this.container.dimensions,
            length: remainingLength,
          },
        };

        const palletSolver = new WallBuilder(virtualContainer, pallets);
        const palletResults = palletSolver.solve();

        palletResults.forEach((item) => {
          item.position.y += maxUsedY;
          placedItems.push(item);
        });
      }
    }

    return placedItems;
  }

  /**
   * Get detailed placement report
   */
  public solveWithReport(items: CargoItem[]): {
    placedItems: PlacedItem[];
    report: {
      totalItems: number;
      placedItems: number;
      unplacedItems: number;
      volumeUtilization: number;
      byType: {
        coils: { placed: number; total: number };
        boxes: { placed: number; total: number };
        pallets: { placed: number; total: number };
      };
    };
  } {
    const placedItems = this.solve(items);

    // Count by type
    const coilsTotal = items.filter((i) => i.type === 'cylinder').reduce((sum, i) => sum + i.quantity, 0);
    const boxesTotal = items.filter((i) => i.type === 'box').reduce((sum, i) => sum + i.quantity, 0);
    const palletsTotal = items.filter((i) => i.type === 'pallet').reduce((sum, i) => sum + i.quantity, 0);

    const coilsPlaced = placedItems.filter((i) => i.type === 'cylinder').length;
    const boxesPlaced = placedItems.filter((i) => i.type === 'box').length;
    const palletsPlaced = placedItems.filter((i) => i.type === 'pallet').length;

    // Calculate volume utilization
    const containerVolume =
      this.container.dimensions.width *
      this.container.dimensions.length *
      this.container.dimensions.height;

    let placedVolume = 0;
    for (const item of placedItems) {
      if (item.type === 'cylinder') {
        const radius = item.dimensions.width / 2;
        placedVolume += Math.PI * radius * radius * item.dimensions.height;
      } else {
        placedVolume +=
          item.dimensions.width * item.dimensions.length * item.dimensions.height;
      }
    }

    return {
      placedItems,
      report: {
        totalItems: coilsTotal + boxesTotal + palletsTotal,
        placedItems: placedItems.length,
        unplacedItems: coilsTotal + boxesTotal + palletsTotal - placedItems.length,
        volumeUtilization: placedVolume / containerVolume,
        byType: {
          coils: { placed: coilsPlaced, total: coilsTotal },
          boxes: { placed: boxesPlaced, total: boxesTotal },
          pallets: { placed: palletsPlaced, total: palletsTotal },
        },
      },
    };
  }
}
