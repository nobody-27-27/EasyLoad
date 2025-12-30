// src/core/solvers/coil-solver/optimized-solver.ts
// Layer-based cylinder packing with proper support checking

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';

interface Cylinder {
  item: CargoItem;
  diameter: number;
  length: number;
  index: number;
}

interface PlacedBox {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  zMin: number;
  zMax: number;
  cylinder: PlacedCylinder;
}

/**
 * Layer-based cylinder packing solver
 *
 * All cylinders are placed HORIZONTALLY (lying along Y axis)
 * Uses layer-based packing with proper support verification
 */
export class OptimizedCoilSolver {
  private W: number;  // Container width (X)
  private L: number;  // Container length (Y)
  private H: number;  // Container height (Z)

  constructor(container: Container, _config: Partial<CoilSolverConfig> = {}) {
    this.W = container.dimensions.width;
    this.L = container.dimensions.length;
    this.H = container.dimensions.height;
  }

  public solve(items: CargoItem[]): CoilSolverResult {
    const cylinders = items.filter(i => i.type === 'cylinder');
    if (cylinders.length === 0) return this.emptyResult();

    // Expand all quantities
    const all: Cylinder[] = [];
    let idx = 0;
    for (const item of cylinders) {
      for (let i = 0; i < item.quantity; i++) {
        all.push({
          item: { ...item, quantity: 1 },
          diameter: item.dimensions.width,
          length: item.dimensions.height,
          index: idx++,
        });
      }
    }

    console.log(`=== CYLINDER PACKING (Layer-Based) ===`);
    console.log(`Container: ${this.W} x ${this.L} x ${this.H} cm`);
    console.log(`Cylinders to place: ${all.length}`);

    // Sort by diameter (largest first) then by length (longest first)
    all.sort((a, b) => {
      if (Math.abs(a.diameter - b.diameter) > 2) return b.diameter - a.diameter;
      return b.length - a.length;
    });

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];
    const unplaced: CargoItem[] = [];

    // Pack layer by layer
    for (const cyl of all) {
      const pos = this.findValidPosition(cyl, placedBoxes);

      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);

        // Track as bounding box
        placedBoxes.push({
          xMin: pos.x,
          xMax: pos.x + cyl.diameter,
          yMin: pos.y,
          yMax: pos.y + cyl.length,
          zMin: pos.z,
          zMax: pos.z + cyl.diameter,
          cylinder: placedCyl,
        });
      } else {
        unplaced.push(cyl.item);
      }
    }

    console.log(`Placed: ${placed.length}/${all.length}`);
    if (unplaced.length > 0) {
      console.log(`Unplaced: ${unplaced.length}`);
    }

    return {
      placedCylinders: placed,
      unplacedItems: unplaced,
      statistics: this.calcStats(placed, unplaced.length),
    };
  }

  /**
   * Find a valid position with proper support
   * Priority: Fill depth (Y) first, then width (X), then stack up (Z)
   */
  private findValidPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    // Check if it even fits in container
    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Determine valid Z levels (floors)
    // Level 0 = ground (z=0)
    // Level 1+ = on top of existing cylinders
    const zLevels = new Set<number>();
    zLevels.add(0); // Ground is always valid

    // Add tops of existing cylinders as potential Z levels
    for (const box of placed) {
      zLevels.add(box.zMax);
    }

    // Sort Z levels (bottom to top)
    const sortedZ = Array.from(zLevels)
      .filter(z => z + diameter <= this.H)
      .sort((a, b) => a - b);

    // Try each Z level
    for (const z of sortedZ) {
      // Generate Y positions to try - use fine grid for complete coverage
      const yPositions = new Set<number>();
      yPositions.add(0);

      // Add positions from existing cylinders
      for (const box of placed) {
        yPositions.add(box.yMax); // Right after existing
        yPositions.add(box.yMin); // Aligned with existing
      }

      // Add grid positions at length intervals for thorough search
      const yStep = Math.min(length, 50);
      for (let y = 0; y + length <= this.L; y += yStep) {
        yPositions.add(y);
      }
      // Always try the last possible position
      yPositions.add(this.L - length);

      const sortedY = Array.from(yPositions)
        .filter(y => y >= 0 && y + length <= this.L)
        .sort((a, b) => a - b);

      // Generate X positions to try - use fine grid for complete coverage
      const xPositions = new Set<number>();
      xPositions.add(0);

      // Add positions from existing cylinders
      for (const box of placed) {
        xPositions.add(box.xMax); // Right of existing
        xPositions.add(box.xMin); // Aligned with existing
      }

      // Add grid positions at diameter intervals
      const xStep = Math.min(diameter, 30);
      for (let x = 0; x + diameter <= this.W; x += xStep) {
        xPositions.add(x);
      }
      // Always try the last possible position
      xPositions.add(this.W - diameter);

      const sortedX = Array.from(xPositions)
        .filter(x => x >= 0 && x + diameter <= this.W)
        .sort((a, b) => a - b);

      // Try each Y, then X position
      for (const y of sortedY) {
        for (const x of sortedX) {
          if (this.isValidPlacement(x, y, z, diameter, length, placed)) {
            return { x, y, z };
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if a position is valid (no collision + proper support)
   */
  private isValidPlacement(
    x: number, y: number, z: number,
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    // Bounds check
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    const newBox = {
      xMin: x,
      xMax: x + diameter,
      yMin: y,
      yMax: y + length,
      zMin: z,
      zMax: z + diameter,
    };

    // Check for collisions
    for (const box of placed) {
      if (this.boxesOverlap(newBox, box)) {
        return false;
      }
    }

    // Check support - z=0 is always supported (floor)
    if (z === 0) {
      return true;
    }

    // For z > 0, must have at least one supporting cylinder
    // A cylinder supports another if:
    // 1. Its top (zMax) equals our bottom (z)
    // 2. Their XY footprints overlap
    let hasSupport = false;
    for (const box of placed) {
      if (Math.abs(box.zMax - z) < 1) { // Top of box is at our level (within 1cm tolerance)
        // Check XY overlap
        if (this.xyOverlap(newBox, box)) {
          hasSupport = true;
          break;
        }
      }
    }

    return hasSupport;
  }

  /**
   * Check if two boxes overlap in 3D
   */
  private boxesOverlap(
    a: { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number },
    b: { xMin: number; xMax: number; yMin: number; yMax: number; zMin: number; zMax: number }
  ): boolean {
    if (a.xMax <= b.xMin || a.xMin >= b.xMax) return false;
    if (a.yMax <= b.yMin || a.yMin >= b.yMax) return false;
    if (a.zMax <= b.zMin || a.zMin >= b.zMax) return false;
    return true;
  }

  /**
   * Check if two boxes overlap in XY plane (for support checking)
   */
  private xyOverlap(
    a: { xMin: number; xMax: number; yMin: number; yMax: number },
    b: { xMin: number; xMax: number; yMin: number; yMax: number }
  ): boolean {
    if (a.xMax <= b.xMin || a.xMin >= b.xMax) return false;
    if (a.yMax <= b.yMin || a.yMin >= b.yMax) return false;
    return true;
  }

  /**
   * Create a PlacedCylinder from position
   */
  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    // Position is the corner (left-front-bottom of bounding box)
    // For horizontal cylinder along Y:
    // - position.x = left edge (center.x - radius)
    // - position.y = front edge (start of cylinder length)
    // - position.z = bottom edge (center.z - radius)

    const position = {
      x: pos.x,
      y: pos.y,
      z: pos.z,
    };

    // Center position
    const center = {
      x: pos.x + radius,
      y: pos.y + cyl.length / 2,
      z: pos.z + radius,
    };

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}`,
      position,
      center,
      radius,
      length: cyl.length,
      orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'],
      layerId: Math.floor(pos.z / 50), // Approximate layer based on Z
      supportedBy: [],
    };
  }

  private calcStats(placed: PlacedCylinder[], failed: number): PackingStatistics {
    if (placed.length === 0) {
      return {
        totalVolumePlaced: 0,
        containerVolumeUsed: 0,
        volumeEfficiency: 0,
        layerCount: 0,
        itemsPlaced: 0,
        itemsFailed: failed,
      };
    }

    let totalVol = 0;
    let maxX = 0, maxY = 0, maxZ = 0;
    const layers = new Set<number>();

    for (const c of placed) {
      totalVol += Math.PI * c.radius * c.radius * c.length;
      layers.add(c.layerId);
      maxX = Math.max(maxX, c.position.x + c.radius * 2);
      maxY = Math.max(maxY, c.position.y + c.length);
      maxZ = Math.max(maxZ, c.position.z + c.radius * 2);
    }

    const usedVol = maxX * maxY * maxZ;

    return {
      totalVolumePlaced: totalVol,
      containerVolumeUsed: usedVol,
      volumeEfficiency: usedVol > 0 ? totalVol / usedVol : 0,
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
