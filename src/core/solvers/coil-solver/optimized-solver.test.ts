// Test file for cylinder packing bug: 57/58 placement failure
// Bug: D85 L149.9 cylinder cannot find placement position
//
// Root cause: The packGuaranteed58 algorithm separates cylinders by diameter:
// - smallDiameter (<85) -> placed VERTICAL
// - largeDiameter (>=85) -> placed HORIZONTAL only
//
// This is suboptimal because D85 L149.9 CAN fit vertically (149.9 < 269 height)
// and vertical placement saves Y space (85cm vs 149.9cm).

import { describe, it, expect } from 'vitest';
import { OptimizedCoilSolver } from './optimized-solver';
import type { CargoItem, Container } from '../../common/types';

// Standard 40HC container dimensions (cm)
const container40HC: Container = {
  name: '40ft High Cube',
  type: '40HC',
  dimensions: { width: 235, length: 1203, height: 269 },
};

// Helper to create a cylinder CargoItem
function createCylinder(
  name: string,
  diameter: number,
  length: number,
  quantity: number
): CargoItem {
  return {
    id: `cyl-${name}-${diameter}-${length}`,
    name,
    type: 'cylinder',
    quantity,
    color: '#888888',
    dimensions: {
      width: diameter,  // diameter
      length: diameter, // diameter (for cylinder, width=length=diameter)
      height: length,   // actual cylinder length
    },
    stackable: true,
    allowedRotation: {
      x: true,  // can be tipped (horizontal)
      y: true,  // can rotate 90° around Y
      z: false,
    },
  };
}

describe('OptimizedCoilSolver - 57/58 Bug Reproduction', () => {
  /**
   * BUG: D85 L149.9 cylinders are NEVER placed vertically.
   *
   * The packGuaranteed58 algorithm has a flaw:
   * - It categorizes D85 as "largeDiameter" (>=85)
   * - largeDiameter cylinders are ONLY placed horizontal
   * - But D85 L149.9 CAN fit vertically (149.9cm < 269cm container height)
   * - Vertical uses 85cm Y-space instead of 149.9cm - a 43% savings!
   *
   * This leads to running out of Y-space when many D85 L149.9 are horizontal,
   * causing the 57/58 placement failure.
   */
  it('should place D85 L149.9 vertically when beneficial for space efficiency', () => {
    // D85 L149.9 can fit vertically since container height (269) > length (149.9)
    // Vertical placement saves Y space: 85cm vs 149.9cm (43% reduction)
    const cylinders: CargoItem[] = [
      createCylinder('RULO 85x149.9', 85, 149.9, 5),
    ];

    const solver = new OptimizedCoilSolver(container40HC);
    const result = solver.solve(cylinders);

    expect(result.placedCylinders.length).toBe(5);
    expect(result.unplacedItems.length).toBe(0);

    // BUG: Currently all D85 L149.9 are placed horizontal, never vertical
    // The algorithm should consider vertical placement for D85 when it saves space
    const verticalCount = result.placedCylinders.filter(
      (c) => c.orientation === 'vertical'
    ).length;

    // FIX EXPECTED: At least some D85 L149.9 should be placed vertically
    // since vertical saves 43% Y-space and length (149.9) fits in height (269)
    expect(verticalCount).toBeGreaterThan(0);
  });

  it('should place all cylinders when D85 L149.9 can go vertical to save space', () => {
    // This test creates a scenario where horizontal D85 L149.9 would run out of Y-space
    // but vertical placement would allow all to fit
    //
    // Container: 235W x 1203L x 269H
    // D85 horizontal: uses 149.9cm Y per row (2 fit in 235cm width)
    // D85 vertical: uses 85cm Y per row (2 fit in 235cm width)

    const cylinders: CargoItem[] = [
      // Fill with D78 vertical first (these work fine)
      createCylinder('RULO 78x160', 78, 160, 24),
      // Add D85 L149.9 - if all horizontal, may run out of Y space
      createCylinder('RULO 85x149.9', 85, 149.9, 16),
    ];
    // Total: 40 cylinders

    const solver = new OptimizedCoilSolver(container40HC);
    const result = solver.solve(cylinders);

    const totalToPlace = cylinders.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalToPlace).toBe(40);

    // All cylinders should be placed
    expect(result.placedCylinders.length).toBe(totalToPlace);
    expect(result.unplacedItems.length).toBe(0);
  });

  it('should handle edge case with tight D85 L149.9 placement', () => {
    // A minimal reproduction case focused on D85 L149.9
    const cylinders: CargoItem[] = [
      // Fill most of the space with D78 vertical cylinders
      createCylinder('RULO 78x160', 78, 160, 30),
      // Then try to fit D85 L149.9 - this tests if vertical option is considered
      createCylinder('RULO 85x149.9', 85, 149.9, 10),
    ];

    const solver = new OptimizedCoilSolver(container40HC);
    const result = solver.solve(cylinders);

    const totalToPlace = cylinders.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalToPlace).toBe(40);

    // Verify all cylinders are placed
    expect(result.placedCylinders.length).toBe(totalToPlace);
    expect(result.unplacedItems.length).toBe(0);
  });

  /**
   * BUG REPRODUCTION: 57/58 placement failure
   *
   * This test uses a diverse cargo mix that triggers the bug where:
   * - packVerticalPriority becomes the best strategy (not packGuaranteed58)
   * - Y gaps found at end of container are too small for D85
   * - The last D85 L149.9 cannot find a position
   * - But there IS space available that the algorithm misses
   *
   * The cargo mix includes multiple diameter sizes and lengths,
   * which complicates the packing and exposes algorithm limitations.
   */
  it('should place all 58 cylinders when space is available (57/58 bug)', () => {
    // Diverse cargo mix that may trigger algorithm limitations
    // Mix of diameters: D60, D78, D85, D90, D100
    // Mix of lengths: 137.2, 149.9, 152.4, 160, 200, 250
    const cylinders: CargoItem[] = [
      // Various D78 lengths
      createCylinder('RULO 78x160', 78, 160, 20),
      createCylinder('RULO 78x152.4', 78, 152.4, 8),
      createCylinder('RULO 78x137.2', 78, 137.2, 6),
      // D85 cylinders - the problematic ones
      createCylinder('RULO 85x149.9', 85, 149.9, 12),
      // Larger diameter cylinders
      createCylinder('RULO 90x200', 90, 200, 6),
      createCylinder('RULO 100x250', 100, 250, 4),
      // Small diameter cylinder
      createCylinder('RULO 60x160', 60, 160, 2),
    ];

    const totalToPlace = cylinders.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalToPlace).toBe(58);

    const solver = new OptimizedCoilSolver(container40HC);
    const result = solver.solve(cylinders);

    // BUG: May place less than 58 due to algorithm limitations
    // with diverse cargo that doesn't fit the "guaranteed" patterns
    expect(result.placedCylinders.length).toBe(totalToPlace);
    expect(result.unplacedItems.length).toBe(0);
  });

  /**
   * BUG REPRODUCTION: Alternative scenario with tight Y-space
   *
   * This creates conditions where Y-space gets fragmented:
   * - Multiple horizontal layers at different Z levels
   * - Only small Y gaps remain at container end
   * - D85 L149.9 should fit but algorithm can't find position
   */
  it('should find placement when Y-space is fragmented (57/58 variant)', () => {
    // This mix creates fragmented Y-space usage
    const cylinders: CargoItem[] = [
      // Long D100 cylinders consume significant Y space horizontally
      createCylinder('RULO 100x250', 100, 250, 8),
      // D85 medium length
      createCylinder('RULO 85x149.9', 85, 149.9, 18),
      // D78 fill the gaps
      createCylinder('RULO 78x160', 78, 160, 24),
      // Small D60 for remaining spots
      createCylinder('RULO 60x137.2', 60, 137.2, 8),
    ];

    const totalToPlace = cylinders.reduce((sum, c) => sum + c.quantity, 0);
    expect(totalToPlace).toBe(58);

    const solver = new OptimizedCoilSolver(container40HC);
    const result = solver.solve(cylinders);

    // All 58 should be placed
    expect(result.placedCylinders.length).toBe(totalToPlace);
    expect(result.unplacedItems.length).toBe(0);
  });
});
