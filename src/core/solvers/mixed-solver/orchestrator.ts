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

    // 2. Solve COILS using the OptimizedCoilSolver
    if (coils.length > 0) {
      const coilSolver = new OptimizedCoilSolver(this.container);
      const coilResult = coilSolver.solve(coils);

      // Convert PlacedCylinder to PlacedItem
      const coilPlacedItems = coilResult.placedCylinders.map((cyl) => ({
        ...cyl.item,
        uniqueId: cyl.uniqueId,
        position: cyl.position,
        rotation: cyl.rotation,
        center: cyl.center, // <-- KRİTİK: Merkez bilgisini aktarıyoruz
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

      if (coilResult.unplacedItems.length > 0) {
        console.warn(
          `Could not place ${coilResult.unplacedItems.length} coil(s):`,
          coilResult.unplacedItems.map((i) => i.name)
        );
      }
    }

    // 3. Calculate remaining space for BOXES
    let maxUsedY = 0;
    placedItems.forEach((item) => {
      let ySize: number;
      if (item.type === 'cylinder') {
        if (Math.abs(item.rotation.x) > 0.1) {
          ySize = item.dimensions.height;
        } else if (Math.abs(item.rotation.z) > 0.1) {
          ySize = item.dimensions.width;
        } else {
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
        const virtualContainer: Container = {
          ...this.container,
          dimensions: {
            ...this.container.dimensions,
            length: remainingLength,
          },
        };

        const boxSolver = new WallBuilder(virtualContainer, boxes);
        const boxResults = boxSolver.solve();

        boxResults.forEach((item) => {
          item.position.y += maxUsedY;
          placedItems.push(item);
        });
      } else {
        console.warn('No remaining space for boxes after coil placement');
      }
    }

    // 5. Handle PALLETS
    if (pallets.length > 0) {
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

  public solveWithReport(items: CargoItem[]): any {
    const placedItems = this.solve(items);
    
    const containerVolume = this.container.dimensions.width * this.container.dimensions.length * this.container.dimensions.height;
    let placedVolume = 0;
    
    placedItems.forEach(item => {
       if (item.type === 'cylinder') {
         const r = item.dimensions.width / 2;
         placedVolume += Math.PI * r * r * item.dimensions.height;
       } else {
         placedVolume += item.dimensions.width * item.dimensions.length * item.dimensions.height;
       }
    });

    return {
      placedItems,
      report: {
        totalItems: items.reduce((s, i) => s + i.quantity, 0),
        placedItems: placedItems.length,
        unplacedItems: items.reduce((s, i) => s + i.quantity, 0) - placedItems.length,
        volumeUtilization: placedVolume / containerVolume,
        byType: { coils: {placed:0, total:0}, boxes: {placed:0, total:0}, pallets: {placed:0, total:0} }
      }
    };
  }
}