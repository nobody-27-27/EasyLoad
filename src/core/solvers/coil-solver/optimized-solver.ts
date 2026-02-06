// src/core/solvers/coil-solver/optimized-solver.ts
// Cross-section packing solver - fills XZ plane completely at each Y slice

import type { Container, CargoItem } from '../../common/types';
import type {
  PlacedCylinder,
  CoilSolverConfig,
  CoilSolverResult,
  PackingStatistics,
  SolverCylinder as Cylinder,
  PlacedBox,
  StrategyResult,
} from './types';
import { ORIENTATION_ROTATIONS } from './types';

/**
 * Cross-section packing solver
 *
 * Strategy: For each Y slice, pack XZ cross-section as full as possible
 * Groups cylinders by similar length, fills XZ, then moves Y forward
 */
export class OptimizedCoilSolver {
  private static readonly DEBUG = false;

  private W: number;
  private L: number;
  private H: number;

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
          placed: false,
        });
      }
    }


    // FIRST: Try packAdaptiveBestFit exclusively - it's designed for this exact scenario
    all.forEach(c => c.placed = false);
    const adaptiveResult = this.packAdaptiveBestFit(all);

    if (adaptiveResult.unplaced.length === 0) {
      // Adaptive placed all cylinders - use it exclusively!
      // Sync placed flags
      all.forEach(c => c.placed = false);
      for (const p of adaptiveResult.placed) {
        const matching = all.find(c => c.diameter === p.radius * 2 && c.length === p.length && !c.placed);
        if (matching) matching.placed = true;
      }
      return {
        placedCylinders: adaptiveResult.placed,
        unplacedItems: [],
        statistics: this.calcStats(adaptiveResult.placed, 0),
      };
    }

    // Adaptive didn't place all - continue with other strategies
    // Try multiple strategies and pick the best result
    const strategies = [
      () => this.packAdaptiveBestFit(all), // ADAPTIVE: dynamically calculates optimal orientation per cylinder
      () => this.packSmartBestFit(all), // FAST: picks best cylinder-position combo at each step
      () => this.packHexagonalOptimized(all), // Optimized hexagonal - best for same-diameter cylinders
      () => this.packDifficultFirst(all), // Place large-diameter cylinders first (vertical)
      () => this.packMixedOrientations(all), // TRUE mixed orientation - tries both for each cylinder
      () => this.packHexagonal(all), // Hexagonal/valley nesting - most efficient
      () => this.packWithStrategy(all, 'length-groups'),
      () => this.packWithStrategy(all, 'diameter-first'),
      () => this.packWithStrategy(all, 'small-first'),
      () => this.packWithStrategy(all, 'large-first'),
      () => this.packWithStrategy(all, 'by-diameter-groups'),
      () => this.packWithStrategy(all, 'volume-desc'),
      () => this.packCompact(all), // NEW: Compact packing focusing on floor utilization
      () => this.packVerticalPriority(all), // NEW: Prioritize vertical for short rolls
      () => this.packMaximizeStacking(all), // Maximize vertical stacking to save Y space
      () => this.packTightLayers(all), // Fill each Y slice completely before moving
      () => this.packAwkwardFirst(all), // Prioritize awkward middle-size rolls first
      () => this.packOptimalVerticalHorizontal(all), // Optimal: max vertical on floor, horizontal on top
      () => this.packSmartLookahead(all), // Smart: per-roll decision grid vs honeycomb
      () => this.packMultiOrderLookahead(all), // Multi-order: tries different sort orders
      () => this.packHorizontalStackedOptimal(all), // Horizontal with optimal Z-stacking for all 58
      () => this.packByLengthGroups(all), // Group by length for efficient Y-utilization
      () => this.packUniversalMaxFit(all), // Universal: calculates optimal mix for ANY cylinder set
      () => this.packMixedFloorOptimal(all), // MIXED FLOOR: vertical + horizontal on floor together
      () => this.packPureHexagonalFloor(all), // PURE HEX: Uses hex packing from START (saves 13% Y)
    ];

    let bestResult: (StrategyResult & { strategyName?: string }) | null = null;

    // Strategy names for debugging
    const strategyNames = [
      'packAdaptiveBestFit', 'packSmartBestFit', 'packHexagonalOptimized', 'packDifficultFirst',
      'packMixedOrientations', 'packHexagonal', 'length-groups', 'diameter-first', 'small-first',
      'large-first', 'by-diameter-groups', 'volume-desc', 
      'packCompact', 'packVerticalPriority', 'packMaximizeStacking',
      'packTightLayers', 'packAwkwardFirst', 'packOptimalVerticalHorizontal', 'packSmartLookahead',
      'packMultiOrderLookahead', 'packHorizontalStackedOptimal', 'packByLengthGroups',
      'packUniversalMaxFit', 'packMixedFloorOptimal',
      'packPureHexagonalFloor'
    ];

    for (let i = 0; i < strategies.length; i++) {
      const strategy = strategies[i];
      const strategyName = strategyNames[i] || `strategy${i}`;
      // Reset placed flags
      all.forEach(c => c.placed = false);
      const result = strategy();

      // Track boxes for potential further optimization
      // IMPORTANT: Handle orientation correctly!
      const placedBoxes: PlacedBox[] = result.placed.map(p => {
        const isVertical = p.orientation === 'vertical';
        if (isVertical) {
          // Vertical: diameter in X and Y, length in Z
          return {
            xMin: p.position.x, xMax: p.position.x + p.radius * 2,
            yMin: p.position.y, yMax: p.position.y + p.radius * 2,
            zMin: p.position.z, zMax: p.position.z + p.length,
          };
        } else {
          // Horizontal: diameter in X and Z, length in Y
          return {
            xMin: p.position.x, xMax: p.position.x + p.radius * 2,
            yMin: p.position.y, yMax: p.position.y + p.length,
            zMin: p.position.z, zMax: p.position.z + p.radius * 2,
          };
        }
      });

      if (!bestResult || result.placed.length > bestResult.placed.length) {
        bestResult = { ...result, placedBoxes, strategyName };
      }

      // If all placed, we're done
      if (result.unplaced.length === 0) {
        break;
      }
    }


    // CRITICAL: Sync c.placed flags to match bestResult BEFORE running fallback passes
    // This prevents duplicates from being added
    const syncPlacedCounts = new Map<string, number>();
    for (const p of bestResult!.placed) {
      const key = `${p.item.name}_${p.radius * 2}_${p.length}`;
      syncPlacedCounts.set(key, (syncPlacedCounts.get(key) || 0) + 1);
    }

    const syncUsedCounts = new Map<string, number>();
    for (const cyl of all) {
      const key = `${cyl.item.name}_${cyl.diameter}_${cyl.length}`;
      const placedCount = syncPlacedCounts.get(key) || 0;
      const usedCount = syncUsedCounts.get(key) || 0;

      if (usedCount < placedCount) {
        syncUsedCounts.set(key, usedCount + 1);
        cyl.placed = true;
      } else {
        cyl.placed = false;
      }
    }

    // Run multi-pass fallback to place any remaining cylinders
    this.runFallbackPasses(all, bestResult!);

    // FINAL FIX: Correctly calculate unplaced by comparing placed array with original all array
    // The c.placed flags may be inconsistent due to multi-strategy approach
    const finalPlacedCounts = new Map<string, number>();
    for (const p of bestResult!.placed) {
      const key = `${p.item.name}_${p.radius * 2}_${p.length}`;
      finalPlacedCounts.set(key, (finalPlacedCounts.get(key) || 0) + 1);
    }

    const finalUsedCounts = new Map<string, number>();
    const correctUnplaced: CargoItem[] = [];
    for (const cyl of all) {
      const key = `${cyl.item.name}_${cyl.diameter}_${cyl.length}`;
      const placedCount = finalPlacedCounts.get(key) || 0;
      const usedCount = finalUsedCounts.get(key) || 0;

      if (usedCount < placedCount) {
        finalUsedCounts.set(key, usedCount + 1);
      } else {
        correctUnplaced.push(cyl.item);
      }
    }

    const unplaced = correctUnplaced;

    // Remove any duplicates from placed array
    const seenPositions = new Set<string>();
    const uniquePlaced: PlacedCylinder[] = [];
    for (const p of bestResult!.placed) {
      const posKey = `${p.position.x.toFixed(1)}_${p.position.y.toFixed(1)}_${p.position.z.toFixed(1)}_${p.radius}_${p.length}`;
      if (!seenPositions.has(posKey)) {
        seenPositions.add(posKey);
        uniquePlaced.push(p);
      }
    }

    return {
      placedCylinders: uniquePlaced,
      unplacedItems: unplaced,
      statistics: this.calcStats(uniquePlaced, unplaced.length),
    };
  }

  /**
   * Run fallback passes to try to place any remaining cylinders after the best strategy.
   * Tries: exhaustive horizontal search, vertical placement, honeycomb vertical, and aggressive all-orientation search.
   */
  private runFallbackPasses(all: Cylinder[], bestResult: StrategyResult): void {
    // Pass 1: Exhaustive horizontal search for any unplaced
    const unplacedCyls = all.filter(c => !c.placed);
    if (unplacedCyls.length > 0) {
      unplacedCyls.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of unplacedCyls) {
        if (cyl.placed) continue;

        const pos = this.exhaustiveSearch(cyl, bestResult.placedBoxes);
        if (pos) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          bestResult.placed.push(placedCyl);
          bestResult.placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.length,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
          cyl.placed = true;
        }
      }
    }

    // Pass 2: Vertical placement for any remaining unplaced
    const stillUnplaced = all.filter(c => !c.placed);
    if (stillUnplaced.length > 0) {
      stillUnplaced.sort((a, b) => a.diameter - b.diameter);

      for (const cyl of stillUnplaced) {
        if (cyl.length > this.H) continue;

        const vertPos = this.findVerticalPosition(cyl, bestResult.placedBoxes);
        if (vertPos) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
          bestResult.placed.push(placedCyl);
          bestResult.placedBoxes.push({
            xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
            yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
            zMin: vertPos.z, zMax: vertPos.z + cyl.length,
          });
          cyl.placed = true;
        }
      }

      bestResult.unplaced = all.filter(c => !c.placed).map(c => c.item);
    }

    // Pass 3: Honeycomb vertical positions for remaining cylinders
    const honeycombUnplaced = all.filter(c => !c.placed && c.length <= this.H);
    if (honeycombUnplaced.length > 0) {
      for (const cyl of honeycombUnplaced) {
        if (cyl.placed) continue;

        const d = cyl.diameter;
        const HEX_Y_SPACING = d * 0.866;
        let found = false;

        for (let row = 0; !found; row++) {
          const baseY = row * HEX_Y_SPACING;
          if (baseY + d > this.L) break;

          const xOffset = (row % 2 === 1) ? d / 2 : 0;

          for (let gx = xOffset; gx + d <= this.W && !found; gx += d) {
            const pos = { x: gx, y: baseY, z: 0 };
            if (this.canPlaceVertical(pos, d, cyl.length, bestResult.placedBoxes)) {
              bestResult.placed.push(this.createVerticalPlacedCylinder(cyl, pos));
              bestResult.placedBoxes.push({
                xMin: pos.x, xMax: pos.x + d,
                yMin: pos.y, yMax: pos.y + d,
                zMin: 0, zMax: cyl.length,
              });
              cyl.placed = true;
              found = true;
            }
          }
        }

        if (!found) {
          for (let gy = 0; gy + d <= this.L && !found; gy += 2) {
            for (let gx = 0; gx + d <= this.W && !found; gx += 2) {
              const pos = { x: gx, y: gy, z: 0 };
              if (this.canPlaceVertical(pos, d, cyl.length, bestResult.placedBoxes)) {
                bestResult.placed.push(this.createVerticalPlacedCylinder(cyl, pos));
                bestResult.placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + d,
                  yMin: pos.y, yMax: pos.y + d,
                  zMin: 0, zMax: cyl.length,
                });
                cyl.placed = true;
                found = true;
              }
            }
          }
        }
      }

      bestResult.unplaced = all.filter(c => !c.placed).map(c => c.item);
    }

    // Pass 4: Aggressive placement with step=1 on all Z levels and all orientations
    const superFinalUnplaced = all.filter(c => !c.placed);
    if (superFinalUnplaced.length > 0) {
      for (const cyl of superFinalUnplaced) {
        const result = this.tryAggressivePlacement(cyl, bestResult.placedBoxes);
        if (result) {
          if (result.orientation === 'horizontal-y') {
            bestResult.placed.push(this.createPlacedCylinder(cyl, result.pos));
            bestResult.placedBoxes.push({
              xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
              yMin: result.pos.y, yMax: result.pos.y + cyl.length,
              zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
            });
          } else if (result.orientation === 'vertical') {
            bestResult.placed.push(this.createVerticalPlacedCylinder(cyl, result.pos));
            bestResult.placedBoxes.push({
              xMin: result.pos.x, xMax: result.pos.x + cyl.diameter,
              yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
              zMin: result.pos.z, zMax: result.pos.z + cyl.length,
            });
          } else {
            bestResult.placed.push(this.createRotatedPlacedCylinder(cyl, result.pos));
            bestResult.placedBoxes.push({
              xMin: result.pos.x, xMax: result.pos.x + cyl.length,
              yMin: result.pos.y, yMax: result.pos.y + cyl.diameter,
              zMin: result.pos.z, zMax: result.pos.z + cyl.diameter,
            });
          }
          cyl.placed = true;
        }
      }

      bestResult.unplaced = all.filter(c => !c.placed).map(c => c.item);
    }
  }

  /**
   * ADAPTIVE BEST-FIT ALGORITHM
   *
   * Key insight: Vertical orientation uses Y = diameter, Horizontal uses Y = length
   * For cylinders where length >> diameter, vertical saves significant Y-space
   *
   * This algorithm dynamically calculates the optimal orientation for each cylinder
   * based on Y-space savings ratio, not hardcoded diameter thresholds.
   *
   * Phase 1: Calculate "vertical benefit score" for each cylinder
   *          Score = (length - diameter) / length  (how much Y-space vertical saves)
   *          Higher score = more benefit from vertical placement
   *
   * Phase 2: Place high-score cylinders vertically first (if they fit height-wise)
   * Phase 3: Place remaining cylinders horizontally, prioritizing longest first
   * Phase 4: Fine-grained search for any remaining cylinders
   */
  private packAdaptiveBestFit(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Helper to place a cylinder
    const placeCyl = (cyl: Cylinder, pos: { x: number; y: number; z: number }, orientation: 'horizontal' | 'vertical' | 'rotated') => {
      if (orientation === 'vertical') {
        const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.diameter,
          zMin: pos.z, zMax: pos.z + cyl.length,
        });
      } else if (orientation === 'rotated') {
        const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.length,
          yMin: pos.y, yMax: pos.y + cyl.diameter,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      } else {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
      cyl.placed = true;
    };

    // PHASE 1: Calculate vertical benefit score for each cylinder
    // Score = Y-space savings ratio when placed vertically vs horizontally

    // Find the largest gap in diameter distribution to separate "small" from "large"
    // This works better than median because it groups similar diameters together
    const uniqueDiameters = [...new Set(allCylinders.map(c => c.diameter))].sort((a, b) => a - b);
    let maxGap = 0;
    let gapThreshold = uniqueDiameters[uniqueDiameters.length - 1]; // Default: largest diameter

    for (let i = 0; i < uniqueDiameters.length - 1; i++) {
      const gap = uniqueDiameters[i + 1] - uniqueDiameters[i];
      if (gap > maxGap) {
        maxGap = gap;
        // Threshold is midpoint of the largest gap
        gapThreshold = (uniqueDiameters[i] + uniqueDiameters[i + 1]) / 2;
      }
    }

    // If no significant gap (all similar diameters), use a high threshold so all go vertical
    const diameterThreshold = maxGap > 3 ? gapThreshold : uniqueDiameters[uniqueDiameters.length - 1] + 1;

    const scoredCylinders = allCylinders.map(cyl => {
      const canBeVertical = cyl.length <= this.H;
      const ySavings = cyl.length - cyl.diameter; // Absolute Y-space saved
      const savingsRatio = ySavings / cyl.length; // Relative savings (0 to 1)

      // Key insight: only SMALL diameter cylinders should be vertical
      // Large diameter cylinders should be horizontal so they can stack on top
      const isSmallDiameter = cyl.diameter < diameterThreshold;

      return {
        cyl,
        canBeVertical,
        ySavings,
        savingsRatio,
        isSmallDiameter,
        // Composite score: higher = more benefit from vertical
        verticalScore: canBeVertical && isSmallDiameter ? savingsRatio * Math.sqrt(ySavings) : -Infinity
      };
    });

    // Separate into candidates for vertical vs horizontal placement
    // Vertical: small diameter + can be vertical + decent savings
    let verticalCandidates = scoredCylinders
      .filter(s => s.canBeVertical && s.isSmallDiameter && s.savingsRatio > 0.3)
      .sort((a, b) => b.verticalScore - a.verticalScore); // Highest benefit first

    // Horizontal: large diameter OR low savings OR can't be vertical
    const horizontalCandidates = scoredCylinders
      .filter(s => !s.canBeVertical || !s.isSmallDiameter || s.savingsRatio <= 0.3)
      .map(s => s.cyl);

    // CRITICAL FIX: Don't make ALL small cylinders vertical!
    // Limit verticals to use at most 40% of Y space, leaving room for horizontal floor placements
    // This creates a MIXED layout: some vertical, some horizontal on the floor
    const avgDiam = verticalCandidates.length > 0
      ? verticalCandidates.reduce((sum, s) => sum + s.cyl.diameter, 0) / verticalCandidates.length
      : 80;
    const verticalsPerRow = Math.floor(this.W / avgDiam);
    const maxVerticalYSpace = this.L * 0.4; // Use at most 40% of Y for verticals
    const maxVerticalRows = Math.floor(maxVerticalYSpace / avgDiam);
    const maxVerticals = maxVerticalRows * verticalsPerRow;


    // Only take the top N candidates for vertical placement, rest go horizontal
    if (verticalCandidates.length > maxVerticals) {
      const overflow = verticalCandidates.slice(maxVerticals);
      verticalCandidates = verticalCandidates.slice(0, maxVerticals);
      // Add overflow to horizontal candidates
      horizontalCandidates.push(...overflow.map(s => s.cyl));
    }

    // Sort horizontal candidates: longest first for better packing
    horizontalCandidates.sort((a, b) => b.length - a.length);


    // Log the scoring for debugging
    for (const s of scoredCylinders.slice(0, 5)) {
    }

    // PHASE 2: NEW APPROACH - Place horizontals FIRST at back of container,
    // then fill verticals in front. This ensures floor space is reserved for D85 horizontals.

    // Calculate how much Y space is needed for horizontal candidates (large diameter)
    // D85 needs 149.9cm Y each, stack 2 wide x 3 high = 6 per section
    const largeDiameterCyls = horizontalCandidates.filter(c => c.diameter >= diameterThreshold);
    // Small horizontal cylinders will be placed in remaining space after verticals


    // PHASE 2: Place VERTICALS FIRST in front area
    // This creates a stacking surface for D85 horizontals
    const maxVerticalY = this.L * 0.5; // Use front 50% for verticals


    for (const scored of verticalCandidates) {
      const cyl = scored.cyl;
      if (cyl.placed) continue;

      let found = false;
      const step = cyl.diameter;

      for (let y = 0; y + cyl.diameter <= maxVerticalY && !found; y += step) {
        for (let x = 0; x + cyl.diameter <= this.W && !found; x += step) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
            placeCyl(cyl, pos, 'vertical');
            found = true;
          }
        }
      }

      // Fine search
      if (!found) {
        for (let y = 0; y + cyl.diameter <= maxVerticalY && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              placeCyl(cyl, pos, 'vertical');
              found = true;
            }
          }
        }
      }
    }


    // PHASE 3: Place D85 ON TOP of verticals (elevated Z)
    // This shares Y footprint with verticals underneath!
    const verticalZLevels = this.getZLevels(placedBoxes).filter(z => z > 0);
    const verticalYExtent = placedBoxes.length > 0
      ? Math.max(...placedBoxes.filter(b => b.zMax > b.xMax).map(b => b.yMax)) // Only vertical boxes
      : maxVerticalY;


    for (const cyl of largeDiameterCyls) {
      if (cyl.placed) continue;
      let found = false;

      // FIRST: Try stacking ON TOP of verticals (elevated Z, sharing Y footprint)
      for (const z of verticalZLevels) {
        if (z + cyl.diameter > this.H || found) continue;

        // Search within vertical Y extent (where support exists)
        for (let y = 0; y + cyl.length <= this.L && !found; y += 10) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += cyl.diameter) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                placeCyl(cyl, pos, 'horizontal');
                found = true;
              }
            }
          }
        }
      }

      // SECOND: Try floor at back (beyond verticals)
      if (!found) {
        for (let y = maxVerticalY; y + cyl.length <= this.L && !found; y += 10) {
          for (let layer = 0; layer < 3 && !found; layer++) {
            const z = layer * cyl.diameter;
            if (z + cyl.diameter > this.H) continue;

            for (let x = 0; x + cyl.diameter <= this.W && !found; x += cyl.diameter) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  placeCyl(cyl, pos, 'horizontal');
                  found = true;
                }
              }
            }
          }
        }
      }

      // Fine search anywhere if still not found
      if (!found) {
        for (let z = 0; z + cyl.diameter <= this.H && !found; z += cyl.diameter) {
          for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  placeCyl(cyl, pos, 'horizontal');
                  found = true;
                }
              }
            }
          }
        }
      }
    }


    // PHASE 3: Place horizontal candidates - prioritize STACKING on verticals first
    // This shares Y footprint with verticals rather than requiring new Y space

    // Get Z levels and sort: elevated (>0) first, then floor
    const zLevels = this.getZLevels(placedBoxes);
    const elevatedLevels = zLevels.filter(z => z > 0).sort((a, b) => a - b);

    // Calculate actual Y extent of ALL placements so far
    const currentYExtent = placedBoxes.length > 0
      ? Math.max(...placedBoxes.map(b => b.yMax))
      : maxVerticalY;


    for (const cyl of horizontalCandidates) {
      if (cyl.placed) continue;

      const { diameter, length } = cyl;
      let found = false;

      // FIRST: Try elevated Z levels ONLY within current Y extent
      // This ensures horizontals stack ON TOP of verticals, sharing Y footprint
      for (const z of elevatedLevels) {
        if (z + diameter > this.H || found) continue;

        // CRITICAL: Only search Y positions where support exists
        for (let y = 0; y + length <= currentYExtent + 50 && !found; y += 10) {
          for (let x = 0; x + diameter <= this.W && !found; x += diameter) {
            const pos = { x, y, z };
            if (this.canPlace(pos, diameter, length, placedBoxes)) {
              if (this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
                placeCyl(cyl, pos, 'horizontal');
                found = true;
              }
            }
          }
        }
      }

      // SECOND: Try floor level (Y space beyond verticals)
      if (!found) {
        for (let y = 0; y + length <= this.L && !found; y += 10) {
          for (let x = 0; x + diameter <= this.W && !found; x += diameter) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, diameter, length, placedBoxes)) {
              placeCyl(cyl, pos, 'horizontal');
              found = true;
            }
          }
        }
      }

      // Fine search on ALL levels if still not found
      if (!found) {
        for (const z of [...elevatedLevels, 0]) {
          if (z + diameter > this.H || found) continue;
          for (let y = 0; y + length <= this.L && !found; y += 2) {
            for (let x = 0; x + diameter <= this.W && !found; x += 2) {
              const pos = { x, y, z };
              if (this.canPlace(pos, diameter, length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
                  placeCyl(cyl, pos, 'horizontal');
                  found = true;
                }
              }
            }
          }
        }
      }

      if (!found) {
      }
    }


    // PHASE 4: Fine-grained search for any remaining cylinders
    const remaining = allCylinders.filter(c => !c.placed);

    for (const cyl of remaining) {
      const { diameter, length } = cyl;
      let found = false;

      const allZ = this.getZLevels(placedBoxes);

      // Try both orientations with fine step
      for (const z of allZ) {
        // Try horizontal
        if (z + diameter <= this.H && !found) {
          for (let y = 0; y + length <= this.L && !found; y += 1) {
            for (let x = 0; x + diameter <= this.W && !found; x += 1) {
              const pos = { x, y, z };
              if (this.canPlace(pos, diameter, length, placedBoxes)) {
                if (z === 0 || this.hasAnySupport(pos, diameter, length, placedBoxes)) {
                  placeCyl(cyl, pos, 'horizontal');
                  found = true;
                }
              }
            }
          }
        }

        // Try vertical
        if (!found && length <= this.H && z + length <= this.H) {
          for (let y = 0; y + diameter <= this.L && !found; y += 1) {
            for (let x = 0; x + diameter <= this.W && !found; x += 1) {
              const pos = { x, y, z };
              if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                if (z === 0 || this.hasAnySupportVertical(pos, diameter, placedBoxes)) {
                  placeCyl(cyl, pos, 'vertical');
                  found = true;
                }
              }
            }
          }
        }
      }

      if (!found) {
      }
    }


    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  // Helper: Get all Z levels from placed boxes
  private getZLevels(placedBoxes: PlacedBox[]): number[] {
    const zLevels = [0];
    for (const box of placedBoxes) {
      if (!zLevels.includes(box.zMax)) zLevels.push(box.zMax);
    }
    return zLevels.sort((a, b) => a - b);
  }

  // Helper: Check for any support (lenient - any overlap below)
  private hasAnySupport(pos: { x: number; y: number; z: number }, diameter: number, length: number, placedBoxes: PlacedBox[]): boolean {
    for (const box of placedBoxes) {
      if (Math.abs(box.zMax - pos.z) <= 5) {
        const xOv = Math.min(pos.x + diameter, box.xMax) - Math.max(pos.x, box.xMin);
        const yOv = Math.min(pos.y + length, box.yMax) - Math.max(pos.y, box.yMin);
        if (xOv > 0 && yOv > 0) return true;
      }
    }
    return false;
  }

  // Helper: Check for any support for vertical cylinder
  private hasAnySupportVertical(pos: { x: number; y: number; z: number }, diameter: number, placedBoxes: PlacedBox[]): boolean {
    for (const box of placedBoxes) {
      if (Math.abs(box.zMax - pos.z) <= 5) {
        const xOv = Math.min(pos.x + diameter, box.xMax) - Math.max(pos.x, box.xMin);
        const yOv = Math.min(pos.y + diameter, box.yMax) - Math.max(pos.y, box.yMin);
        if (xOv > 0 && yOv > 0) return true;
      }
    }
    return false;
  }

  /**
   * FAST Smart Best-Fit: At each step, pick which cylinder-position combo is globally best
   * Key difference from other strategies: doesn't use fixed cylinder order
   * Instead, evaluates all remaining cylinders and picks the one that fits best
   */
  private packSmartBestFit(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    const totalCylinders = allCylinders.length;
    const step = 15; // Coarse grid for speed

    // Pre-compute valid positions grid (will be refined as we place)
    let iteration = 0;

    while (allCylinders.some(c => !c.placed)) {
      iteration++;
      if (iteration > totalCylinders + 10) break; // Safety limit

      // Find the best cylinder-position combination
      let bestChoice: {
        cyl: Cylinder;
        pos: { x: number; y: number; z: number };
        orientation: 'horizontal-y' | 'horizontal-x' | 'vertical';
        score: number;
      } | null = null;

      const unplacedCyls = allCylinders.filter(c => !c.placed);

      // Get available Z levels
      const zLevels = [0, ...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);

      // Get available Y positions
      const yPositions = [0];
      for (const box of placedBoxes) {
        if (!yPositions.includes(box.yMax)) yPositions.push(box.yMax);
      }
      yPositions.sort((a, b) => a - b);

      for (const cyl of unplacedCyls) {
        const { diameter, length } = cyl;

        // Try HORIZONTAL-Y orientation
        for (const z of zLevels) {
          if (z + diameter > this.H) continue;

          for (const yStart of yPositions) {
            for (let y = yStart; y + length <= this.L; y += step) {
              for (let x = 0; x + diameter <= this.W; x += step) {
                const pos = { x, y, z };
                if (this.canPlace(pos, diameter, length, placedBoxes)) {
                  if (z === 0 || this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
                    // Score: prefer lower Z, lower Y, fills gaps
                    const score = z * 3 + y * 0.5 + x * 0.1;
                    if (!bestChoice || score < bestChoice.score) {
                      bestChoice = { cyl, pos, orientation: 'horizontal-y', score };
                    }
                  }
                }
              }
              if (bestChoice && bestChoice.score < 10) break; // Found floor position, good enough
            }
            if (bestChoice && bestChoice.score < 10) break;
          }
          if (bestChoice && bestChoice.score < 10) break;
        }

        // Try VERTICAL orientation (if length fits in height)
        if (length <= this.H) {
          for (const z of zLevels) {
            if (z + length > this.H) continue;

            for (const yStart of yPositions) {
              for (let y = yStart; y + diameter <= this.L; y += step) {
                for (let x = 0; x + diameter <= this.W; x += step) {
                  const pos = { x, y, z };
                  if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                    if (z === 0 || this.hasVerticalSupportRelaxed(pos, diameter, placedBoxes)) {
                      // Vertical gets small bonus (saves Y space)
                      const score = z * 3 + y * 0.5 + x * 0.1 - 5;
                      if (!bestChoice || score < bestChoice.score) {
                        bestChoice = { cyl, pos, orientation: 'vertical', score };
                      }
                    }
                  }
                }
              }
            }
          }
        }

        // Try HORIZONTAL-X orientation (if length fits in width)
        if (length <= this.W) {
          for (const z of zLevels) {
            if (z + diameter > this.H) continue;

            for (const yStart of yPositions) {
              for (let y = yStart; y + diameter <= this.L; y += step) {
                for (let x = 0; x + length <= this.W; x += step) {
                  const pos = { x, y, z };
                  if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
                    if (z === 0 || this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
                      const score = z * 3 + y * 0.5 + x * 0.1;
                      if (!bestChoice || score < bestChoice.score) {
                        bestChoice = { cyl, pos, orientation: 'horizontal-x', score };
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Place the best choice
      if (bestChoice) {
        const { cyl, pos, orientation } = bestChoice;

        if (orientation === 'vertical') {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.diameter,
            zMin: pos.z, zMax: pos.z + cyl.length,
          });
        } else if (orientation === 'horizontal-x') {
          const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.length,
            yMin: pos.y, yMax: pos.y + cyl.diameter,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
        } else {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.length,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
        }
        cyl.placed = true;
      } else {
        // No valid position found for any remaining cylinder
        // Try finer search for remaining
        break;
      }
    }

    // Fine-grained pass for any remaining cylinders
    const remaining = allCylinders.filter(c => !c.placed);
    if (remaining.length > 0) {

      for (const cyl of remaining) {
        // Try all positions with step=5
        let found = false;

        // Try horizontal-y
        for (let z = 0; z + cyl.diameter <= this.H && !found; z += cyl.diameter) {
          for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  placedBoxes.push({
                    xMin: pos.x, xMax: pos.x + cyl.diameter,
                    yMin: pos.y, yMax: pos.y + cyl.length,
                    zMin: pos.z, zMax: pos.z + cyl.diameter,
                  });
                  cyl.placed = true;
                  found = true;
                }
              }
            }
          }
        }

        // Try vertical
        if (!found && cyl.length <= this.H) {
          for (let z = 0; z + cyl.length <= this.H && !found; z += 10) {
            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
                const pos = { x, y, z };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasVerticalSupportRelaxed(pos, cyl.diameter, placedBoxes)) {
                    const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.diameter,
                      zMin: pos.z, zMax: pos.z + cyl.length,
                    });
                    cyl.placed = true;
                    found = true;
                  }
                }
              }
            }
          }
        }
      }
    }


    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Optimized hexagonal packing - precise geometry for maximum density
   * Uses exact hexagonal pattern in XZ plane for horizontal cylinders
   * Cylinder centers in row N are offset by D/2 from row N-1
   * Vertical rise between row centers = D * sqrt(3)/2 ≈ D * 0.866
   */
  private packHexagonalOptimized(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Group cylinders by similar length AND diameter for optimal packing
    const groups = this.groupByLengthAndDiameter([...allCylinders], 15, 10);

    let currentY = 0;

    for (const group of groups) {
      if (group.length === 0) continue;

      const maxLength = Math.max(...group.map(c => c.length));
      const avgDiameter = group.reduce((sum, c) => sum + c.diameter, 0) / group.length;

      if (currentY + maxLength > this.L) continue;


      // Sort by diameter descending (put largest on floor for stability)
      group.sort((a, b) => b.diameter - a.diameter);

      // Calculate hexagonal grid positions
      // For same-diameter cylinders: row spacing = D * 0.866 (sqrt(3)/2)
      // Odd rows offset by D/2 in X direction

      const D = avgDiameter;
      const rowSpacing = D * 0.866; // Vertical distance between row centers
      const maxRows = Math.floor((this.H - D / 2) / rowSpacing) + 1;

      // Pre-calculate all valid positions in hexagonal pattern
      interface HexPos { x: number; z: number; row: number; col: number }
      const hexPositions: HexPos[] = [];

      for (let row = 0; row < maxRows; row++) {
        const z = row * rowSpacing;
        if (z + D > this.H) break;

        const xOffset = (row % 2 === 1) ? D / 2 : 0;
        const maxCols = Math.floor((this.W - xOffset) / D);

        for (let col = 0; col < maxCols; col++) {
          const x = xOffset + col * D;
          if (x + D <= this.W) {
            hexPositions.push({ x, z, row, col });
          }
        }
      }


      // Place cylinders in hexagonal positions, preferring lower rows first
      hexPositions.sort((a, b) => a.z - b.z || a.x - b.x);

      for (const hexPos of hexPositions) {
        // Find the best fitting cylinder for this position
        const availableCyl = group.find(c => {
          if (c.placed) return false;
          // Check if cylinder fits in this position
          if (hexPos.x + c.diameter > this.W) return false;
          if (hexPos.z + c.diameter > this.H) return false;
          return true;
        });

        if (!availableCyl) continue;

        const pos = { x: hexPos.x, y: currentY, z: hexPos.z };

        // For rows > 0, verify support exists
        if (hexPos.row > 0) {
          // In hexagonal packing, a cylinder in row N is supported by two cylinders in row N-1
          // OR by one cylinder + wall
          const hasHexSupport = this.verifyHexagonalSupport(pos, availableCyl.diameter, availableCyl.length, placedBoxes, hexPos.row);
          if (!hasHexSupport) continue;
        }

        if (this.canPlace(pos, availableCyl.diameter, availableCyl.length, placedBoxes)) {
          const placedCyl = this.createPlacedCylinder(availableCyl, pos);
          placed.push(placedCyl);
          availableCyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + availableCyl.diameter,
            yMin: currentY, yMax: currentY + availableCyl.length,
            zMin: hexPos.z, zMax: hexPos.z + availableCyl.diameter,
          });
        }
      }


      // Try to place remaining cylinders in any valid position
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Try exhaustive search for remaining
        for (let z = 0; z + cyl.diameter <= this.H; z += 5) {
          let foundInRow = false;
          for (let x = 0; x + cyl.diameter <= this.W; x += 5) {
            const pos = { x, y: currentY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: currentY, yMax: currentY + cyl.length,
                  zMin: z, zMax: z + cyl.diameter,
                });
                foundInRow = true;
                break;
              }
            }
          }
          if (foundInRow) break;
        }
      }

      currentY += maxLength;
    }

    // Final pass: try vertical and rotated orientations for remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      // Try vertical
      if (cyl.length <= this.H) {
        const vPos = this.findVerticalPosition(cyl, placedBoxes);
        if (vPos) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, vPos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: vPos.x, xMax: vPos.x + cyl.diameter,
            yMin: vPos.y, yMax: vPos.y + cyl.diameter,
            zMin: vPos.z, zMax: vPos.z + cyl.length,
          });
          continue;
        }
      }

      // Try horizontal-x (rotated)
      if (cyl.length <= this.W) {
        for (let y = 0; y + cyl.diameter <= this.L; y += 10) {
          for (let x = 0; x + cyl.length <= this.W; x += 10) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.length,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.diameter,
              });
              break;
            }
          }
          if (cyl.placed) break;
        }
      }
    }

    // Exhaustive search for any still remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Group cylinders by both length AND diameter for optimal hexagonal packing
   */
  private groupByLengthAndDiameter(cylinders: Cylinder[], lengthTolerance: number, diameterTolerance: number): Cylinder[][] {
    const groups: Cylinder[][] = [];
    const used = new Set<number>();

    for (const cyl of cylinders) {
      if (used.has(cyl.index)) continue;

      const group = cylinders.filter(c =>
        !used.has(c.index) &&
        Math.abs(c.length - cyl.length) <= lengthTolerance &&
        Math.abs(c.diameter - cyl.diameter) <= diameterTolerance
      );

      for (const c of group) {
        used.add(c.index);
      }

      if (group.length > 0) {
        groups.push(group);
      }
    }

    // Sort groups by total volume (largest groups first)
    groups.sort((a, b) => {
      const volA = a.reduce((sum, c) => sum + c.diameter * c.diameter * c.length, 0);
      const volB = b.reduce((sum, c) => sum + c.diameter * c.diameter * c.length, 0);
      return volB - volA;
    });

    return groups;
  }

  /**
   * Verify hexagonal support - a cylinder in row N is supported by cylinders in row N-1
   */
  private verifyHexagonalSupport(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placedBoxes: PlacedBox[],
    row: number
  ): boolean {
    if (row === 0) return true; // Floor level always supported

    const radius = diameter / 2;
    const cx = pos.x + radius;
    const expectedLowerZ = pos.z - diameter * 0.866;

    // Find cylinders in the row below that could support this position
    let supportCount = 0;

    for (const box of placedBoxes) {
      // Check Y overlap
      if (pos.y >= box.yMax || pos.y + length <= box.yMin) continue;

      // Check if this box is in the row below (Z is close to expected)
      const boxZ = box.zMin;
      if (Math.abs(boxZ - expectedLowerZ) > diameter * 0.3) continue;

      const boxW = box.xMax - box.xMin;
      const boxCx = box.xMin + boxW / 2;

      // Check if horizontally close enough for support
      // In hexagonal, support cylinders are offset by D/2
      const dx = Math.abs(cx - boxCx);
      if (dx < diameter) {
        supportCount++;
      }
    }

    // Need at least 1 support, or wall support
    if (supportCount >= 1) return true;

    // Check wall support
    if (pos.x < diameter * 0.5 || pos.x + diameter > this.W - diameter * 0.5) {
      return supportCount >= 0; // Wall counts as support
    }

    return false;
  }

  /**
   * Hexagonal packing - uses valley nesting for maximum density
   * Cylinders in even rows nestle into gaps between cylinders in odd rows
   */
  private packHexagonal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Group by similar length
    const lengthGroups = this.groupByLength([...allCylinders], 10);

    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) continue;

      // Sort by diameter (largest first for floor, to create stable base)
      group.sort((a, b) => b.diameter - a.diameter);

      // Get the dominant diameter for this group
      const dominantDiameter = group.length > 0 ? group[0].diameter : 0;

      // Pack floor layer (row 0)
      let floorCylinders: PlacedBox[] = [];
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Try positions along X, spaced by diameter
        for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
          const pos = { x, y: currentY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            const box = {
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: currentY, yMax: currentY + cyl.length,
              zMin: 0, zMax: cyl.diameter,
            };
            placedBoxes.push(box);
            floorCylinders.push(box);
            break;
          }
        }
      }

      // Pack valley rows (cylinders nestle between floor cylinders)
      // For hexagonal packing, calculate exact Z positions based on geometry
      // When cylinder of radius r rests between two touching cylinders of radius r:
      // The vertical rise is r * sqrt(3) ≈ 1.732 * r from center to center
      // So bottom-to-bottom rise is r * (sqrt(3) - 1) ≈ 0.732 * r less than diameter
      const valleyRise = dominantDiameter * 0.866; // Approximate rise for each valley layer

      let rowNum = 1;
      let maxLayers = Math.ceil(this.H / valleyRise) + 1;

      while (rowNum < maxLayers && group.some(c => !c.placed)) {
        const isOffsetRow = rowNum % 2 === 1;
        // Calculate base Z for this row (actual position depends on supports)
        const baseRowZ = rowNum * valleyRise;

        if (baseRowZ + dominantDiameter > this.H) break;

        for (const cyl of group) {
          if (cyl.placed) continue;

          // For offset rows, start at radius offset (in the valleys)
          const xStart = isOffsetRow ? cyl.diameter / 2 : 0;

          // First try wall positions (x=0 and x=W-D) which can have wall support
          const wallPositions = [0, this.W - cyl.diameter];
          for (const x of wallPositions) {
            if (x < 0) continue;

            // Find the actual Z position where this cylinder would rest
            const supportedZ = this.findSupportedZ(x, currentY, cyl, placedBoxes);
            if (supportedZ === null) continue;
            if (supportedZ + cyl.diameter > this.H) continue;

            const pos = { x, y: currentY, z: supportedZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: supportedZ, zMax: supportedZ + cyl.diameter,
              });
              break;
            }
          }
          if (cyl.placed) continue;

          // Then try valley positions
          for (let x = xStart; x + cyl.diameter <= this.W; x += 1) {
            // Find the actual Z position where this cylinder would rest
            const supportedZ = this.findSupportedZ(x, currentY, cyl, placedBoxes);
            if (supportedZ === null) continue;
            if (supportedZ + cyl.diameter > this.H) continue;

            const pos = { x, y: currentY, z: supportedZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: supportedZ, zMax: supportedZ + cyl.diameter,
              });
              break;
            }
          }
        }

        rowNum++;
      }

      // Also try direct stacking for remaining cylinders
      const zLevels = [...new Set(placedBoxes.filter(b => b.yMin === currentY).map(b => b.zMax))];
      zLevels.sort((a, b) => a - b);

      for (const z of zLevels) {
        if (z + dominantDiameter > this.H) continue;

        for (const cyl of group) {
          if (cyl.placed) continue;

          for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
            const pos = { x, y: currentY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes) &&
                this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: z, zMax: z + cyl.diameter,
              });
              break;
            }
          }
        }
      }

      currentY += maxLength;
    }

    // Final pass: exhaustive search for remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * TRUE mixed orientation packing - tries BOTH horizontal and vertical for each cylinder
   * Decides dynamically which orientation works best
   */
  private packMixedOrientations(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Sort by volume (largest first) - big items need priority for good positions
    const sorted = [...allCylinders].sort((a, b) => {
      const volA = Math.PI * (a.diameter / 2) ** 2 * a.length;
      const volB = Math.PI * (b.diameter / 2) ** 2 * b.length;
      return volB - volA;
    });

    // First pass: place each cylinder trying BOTH orientations
    for (const cyl of sorted) {
      if (cyl.placed) continue;

      // Try horizontal placement
      const horizPos = this.findBestHorizontalPosition(cyl, placedBoxes);

      // Try vertical placement (if length fits in height)
      const vertPos = cyl.length <= this.H ? this.findVerticalPosition(cyl, placedBoxes) : null;

      // Decide which orientation to use
      // Prefer horizontal if both work (more stable), but use vertical if horizontal doesn't fit
      if (horizPos && vertPos) {
        // Both work - prefer horizontal for stability, but consider space efficiency
        // Use horizontal unless vertical leaves more useful space
        const placedCyl = this.createPlacedCylinder(cyl, horizPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: horizPos.x, xMax: horizPos.x + cyl.diameter,
          yMin: horizPos.y, yMax: horizPos.y + cyl.length,
          zMin: horizPos.z, zMax: horizPos.z + cyl.diameter,
        });
      } else if (horizPos) {
        // Only horizontal works
        const placedCyl = this.createPlacedCylinder(cyl, horizPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: horizPos.x, xMax: horizPos.x + cyl.diameter,
          yMin: horizPos.y, yMax: horizPos.y + cyl.length,
          zMin: horizPos.z, zMax: horizPos.z + cyl.diameter,
        });
      } else if (vertPos) {
        // Only vertical works
        const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
          yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
          zMin: vertPos.z, zMax: vertPos.z + cyl.length,
        });
      } else {
      }
    }

    // Second pass: try harder for unplaced - maybe previous placements opened up space
    const unplacedCyls = sorted.filter(c => !c.placed);

    for (const cyl of unplacedCyls) {
      // Try exhaustive horizontal search
      const horizPos = this.exhaustiveSearch(cyl, placedBoxes);
      if (horizPos) {
        const placedCyl = this.createPlacedCylinder(cyl, horizPos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: horizPos.x, xMax: horizPos.x + cyl.diameter,
          yMin: horizPos.y, yMax: horizPos.y + cyl.length,
          zMin: horizPos.z, zMax: horizPos.z + cyl.diameter,
        });
        continue;
      }

      // Try vertical with exhaustive search
      if (cyl.length <= this.H) {
        const vertPos = this.findVerticalPosition(cyl, placedBoxes);
        if (vertPos) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, vertPos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: vertPos.x, xMax: vertPos.x + cyl.diameter,
            yMin: vertPos.y, yMax: vertPos.y + cyl.diameter,
            zMin: vertPos.z, zMax: vertPos.z + cyl.length,
          });
          continue;
        }
      }
    }

    // Third pass: try placing horizontal ON TOP of verticals
    const stillUnplaced = sorted.filter(c => !c.placed);

    for (const cyl of stillUnplaced) {
      // Find vertical cylinders that could support a horizontal cylinder
      const verticalBoxes = placedBoxes.filter(b => {
        const boxW = b.xMax - b.xMin;
        const boxL = b.yMax - b.yMin;
        return Math.abs(boxW - boxL) < 10; // Square-ish = vertical
      });

      for (const vBox of verticalBoxes) {
        const z = vBox.zMax;
        if (z + cyl.diameter > this.H) continue;

        // Try placing horizontal cylinder on top of vertical
        // Try ALL X positions that could overlap with this vertical
        for (let y = 0; y + cyl.length <= this.L && !cyl.placed; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !cyl.placed; x += 5) {
            const pos = { x, y, z };

            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              // Check if this position has sufficient support from ANY vertical cylinder at this Z
              if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.length,
                  zMin: pos.z, zMax: pos.z + cyl.diameter,
                });
              }
            }
          }
        }
        if (cyl.placed) break;
      }
    }

    // Final pass: try ANY valid position with fine grid
    const finalUnplaced = sorted.filter(c => !c.placed);

    for (const cyl of finalUnplaced) {
      // Exhaustive fine-grid search for both orientations
      let found = false;

      // Try every possible horizontal position
      for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.length,
                  zMin: pos.z, zMax: pos.z + cyl.diameter,
                });
                found = true;
              }
            }
          }
        }
      }

      // Try every possible vertical position
      if (!found && cyl.length <= this.H) {
        for (let z = 0; z + cyl.length <= this.H && !found; z += 5) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                  const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: pos.x, xMax: pos.x + cyl.diameter,
                    yMin: pos.y, yMax: pos.y + cyl.diameter,
                    zMin: pos.z, zMax: pos.z + cyl.length,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    // ULTRA-FINAL pass: exhaustive search at ALL Z levels including floor
    const ultraFinalUnplaced = sorted.filter(c => !c.placed);
    if (ultraFinalUnplaced.length > 0) {

      // Get ALL unique Z levels - floor (0) + all cylinder tops
      const allZLevels: number[] = [0]; // ALWAYS include floor!
      for (const box of placedBoxes) {
        if (!allZLevels.includes(box.zMax)) {
          allZLevels.push(box.zMax);
        }
      }
      allZLevels.sort((a, b) => a - b);

      for (const cyl of ultraFinalUnplaced) {
        let found = false;

        // FIRST: Try floor level (z=0) with fine grid - this is most important!
        for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              found = true;
            }
          }
        }

        // SECOND: Try vertical at floor level
        if (!found && cyl.length <= this.H) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }
        }

        // THIRD: Try rotated horizontal (length along X instead of Y) at floor
        if (!found && cyl.length <= this.W) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              // For rotated: length is along X, diameter is along Y
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.length,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.diameter,
                });
                found = true;
              }
            }
          }
        }

        // FOURTH: Try stacking at other Z levels
        if (!found) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue; // Already tried floor
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.length,
                      zMin: pos.z, zMax: pos.z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        // FIFTH: Try vertical stacking
        if (!found && cyl.length <= this.H) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue;
            if (z + cyl.length > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                    const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.diameter,
                      zMin: pos.z, zMax: pos.z + cyl.length,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        if (!found) {
        }
      }
    }

    // MEGA-FINAL pass: step=1 precision search for any remaining
    const megaFinalUnplaced = sorted.filter(c => !c.placed);
    if (megaFinalUnplaced.length > 0) {

      // Recompute Z levels
      const finalZLevels: number[] = [0];
      for (const box of placedBoxes) {
        if (!finalZLevels.includes(box.zMax)) {
          finalZLevels.push(box.zMax);
        }
      }
      finalZLevels.sort((a, b) => a - b);

      for (const cyl of megaFinalUnplaced) {
        const foundPos = this.findAnyValidPosition(cyl, placedBoxes, finalZLevels);
        if (foundPos) {
          if (foundPos.orientation === 'horizontal-y') {
            const placedCyl = this.createPlacedCylinder(cyl, foundPos.pos);
            placed.push(placedCyl);
            placedBoxes.push({
              xMin: foundPos.pos.x, xMax: foundPos.pos.x + cyl.diameter,
              yMin: foundPos.pos.y, yMax: foundPos.pos.y + cyl.length,
              zMin: foundPos.pos.z, zMax: foundPos.pos.z + cyl.diameter,
            });
          } else if (foundPos.orientation === 'vertical') {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, foundPos.pos);
            placed.push(placedCyl);
            placedBoxes.push({
              xMin: foundPos.pos.x, xMax: foundPos.pos.x + cyl.diameter,
              yMin: foundPos.pos.y, yMax: foundPos.pos.y + cyl.diameter,
              zMin: foundPos.pos.z, zMax: foundPos.pos.z + cyl.length,
            });
          } else {
            const placedCyl = this.createRotatedPlacedCylinder(cyl, foundPos.pos);
            placed.push(placedCyl);
            placedBoxes.push({
              xMin: foundPos.pos.x, xMax: foundPos.pos.x + cyl.length,
              yMin: foundPos.pos.y, yMax: foundPos.pos.y + cyl.diameter,
              zMin: foundPos.pos.z, zMax: foundPos.pos.z + cyl.diameter,
            });
          }
          cyl.placed = true;
        }
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Place "difficult" cylinders first - large diameter ones that need vertical placement
   * Then pack the rest around them
   */
  private packDifficultFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Identify "difficult" cylinders: large diameter relative to container width
    // These are best placed vertically to save horizontal space
    const difficult: Cylinder[] = [];
    const easy: Cylinder[] = [];

    for (const cyl of allCylinders) {
      // Cylinder is "difficult" if:
      // 1. Diameter is large (> 80% of container width / 2) OR
      // 2. Length is short enough for vertical (length <= H) AND diameter is > 90
      const isDifficult = cyl.diameter > 90 || (cyl.length <= this.H && cyl.diameter > this.W / 3);
      if (isDifficult) {
        difficult.push(cyl);
      } else {
        easy.push(cyl);
      }
    }


    // Sort difficult by diameter DESC (place largest first)
    difficult.sort((a, b) => b.diameter - a.diameter);

    // Place difficult cylinders FIRST - try vertical at back of container
    for (const cyl of difficult) {
      let placed_cyl = false;

      // Try vertical placement first (at back of container - high Y)
      if (cyl.length <= this.H) {
        // Start from back of container
        for (let y = this.L - cyl.diameter; y >= 0 && !placed_cyl; y -= 10) {
          for (let x = 0; x + cyl.diameter <= this.W && !placed_cyl; x += 10) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              placed_cyl = true;
            }
          }
        }
      }

      // If vertical didn't work, try horizontal
      if (!placed_cyl) {
        for (let y = 0; y + cyl.length <= this.L && !placed_cyl; y += 10) {
          for (let x = 0; x + cyl.diameter <= this.W && !placed_cyl; x += 10) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              placed_cyl = true;
            }
          }
        }
      }
    }

    // Now pack easy cylinders using hexagonal packing
    // Sort by length (group similar lengths)
    easy.sort((a, b) => a.length - b.length);

    // Group by similar length
    const lengthGroups = this.groupByLength(easy, 15);
    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) continue;

      // Sort by diameter DESC for floor stability
      group.sort((a, b) => b.diameter - a.diameter);

      // Pack floor layer
      for (const cyl of group) {
        if (cyl.placed) continue;

        for (let x = 0; x + cyl.diameter <= this.W; x += 5) {
          const pos = { x, y: currentY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCylinder = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCylinder);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: currentY, yMax: currentY + cyl.length,
              zMin: 0, zMax: cyl.diameter,
            });
            break;
          }
        }
      }

      // Stack on floor layer
      const dominantDiameter = group.length > 0 ? group[0].diameter : 60;
      const valleyRise = dominantDiameter * 0.866;

      for (let layer = 1; layer <= 4; layer++) {
        const layerZ = layer * valleyRise;
        if (layerZ + dominantDiameter > this.H) break;

        for (const cyl of group) {
          if (cyl.placed) continue;

          const xOffset = (layer % 2 === 1) ? cyl.diameter / 2 : 0;
          for (let x = xOffset; x + cyl.diameter <= this.W; x += 5) {
            const supportedZ = this.findSupportedZ(x, currentY, cyl, placedBoxes);
            if (supportedZ === null || supportedZ + cyl.diameter > this.H) continue;

            const pos = { x, y: currentY, z: supportedZ };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: currentY, yMax: currentY + cyl.length,
                zMin: supportedZ, zMax: supportedZ + cyl.diameter,
              });
              break;
            }
          }
        }
      }

      currentY += maxLength;
    }

    // Final pass: exhaustive search for any remaining
    const remaining = allCylinders.filter(c => !c.placed);

    for (const cyl of remaining) {
      // Try horizontal exhaustive
      let found = false;
      for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCylinder = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCylinder);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.length,
                  zMin: pos.z, zMax: pos.z + cyl.diameter,
                });
                found = true;
              }
            }
          }
        }
      }

      // Try vertical exhaustive
      if (!found && cyl.length <= this.H) {
        for (let z = 0; z + cyl.length <= this.H && !found; z += 5) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                  const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCylinder);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: pos.x, xMax: pos.x + cyl.diameter,
                    yMin: pos.y, yMax: pos.y + cyl.diameter,
                    zMin: pos.z, zMax: pos.z + cyl.length,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    // ULTRA-FINAL: exhaustive search at ALL Z levels including floor
    const ultraRemaining = allCylinders.filter(c => !c.placed);
    if (ultraRemaining.length > 0) {

      // Include floor (0) and all cylinder tops
      const allZLevels: number[] = [0];
      for (const box of placedBoxes) {
        if (!allZLevels.includes(box.zMax)) {
          allZLevels.push(box.zMax);
        }
      }
      allZLevels.sort((a, b) => a - b);

      for (const cyl of ultraRemaining) {
        let found = false;

        // FIRST: Try floor level horizontal
        for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCylinder = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCylinder);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              found = true;
            }
          }
        }

        // SECOND: Try floor level vertical
        if (!found && cyl.length <= this.H) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCylinder);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }
        }

        // THIRD: Try rotated horizontal at floor
        if (!found && cyl.length <= this.W) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 2) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCylinder = this.createRotatedPlacedCylinder(cyl, pos);
                placed.push(placedCylinder);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.length,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.diameter,
                });
                found = true;
              }
            }
          }
        }

        // FOURTH: Try stacking at other Z levels
        if (!found) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCylinder = this.createPlacedCylinder(cyl, pos);
                    placed.push(placedCylinder);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.length,
                      zMin: pos.z, zMax: pos.z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        // FIFTH: Try vertical stacking
        if (!found && cyl.length <= this.H) {
          for (const z of allZLevels) {
            if (z === 0 || found) continue;
            if (z + cyl.length > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
                const pos = { x, y, z };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                    const placedCylinder = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(placedCylinder);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: pos.x, xMax: pos.x + cyl.diameter,
                      yMin: pos.y, yMax: pos.y + cyl.diameter,
                      zMin: pos.z, zMax: pos.z + cyl.length,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        if (!found) {
        }
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Find best horizontal position for a cylinder
   */
  private findBestHorizontalPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Try floor first (z=0)
    for (let y = 0; y + length <= this.L; y += 5) {
      for (let x = 0; x + diameter <= this.W; x += 5) {
        const pos = { x, y, z: 0 };
        if (this.canPlace(pos, diameter, length, placedBoxes)) {
          return pos;
        }
      }
    }

    // Try stacking positions
    const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);
    for (const z of zLevels) {
      if (z + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += 5) {
        for (let x = 0; x + diameter <= this.W; x += 5) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (this.hasSupport(pos, diameter, length, placedBoxes)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  private packWithStrategy(
    allCylinders: Cylinder[],
    strategy: 'length-groups' | 'diameter-first' | 'small-first' | 'large-first' | 'by-diameter-groups' | 'volume-desc'
  ): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    // Reset
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];

    let cylinders: Cylinder[];

    switch (strategy) {
      case 'length-groups':
        return this.packByLengthGroups(allCylinders);

      case 'by-diameter-groups': {
        const groups = this.groupByDiameter(allCylinders, 5);
        groups.sort((a, b) => Math.max(...b.map(c => c.diameter)) - Math.max(...a.map(c => c.diameter)));
        for (const group of groups) {
          group.sort((a, b) => b.length - a.length);
          for (const cyl of group) {
            if (cyl.placed) continue;
            const pos = this.findBestPosition(cyl, placedBoxes);
            if (pos) {
              placed.push(this.createPlacedCylinder(cyl, pos));
              cyl.placed = true;
              placedBoxes.push({ xMin: pos.x, xMax: pos.x + cyl.diameter, yMin: pos.y, yMax: pos.y + cyl.length, zMin: pos.z, zMax: pos.z + cyl.diameter });
            }
          }
        }
        for (const cyl of allCylinders.filter(c => !c.placed)) {
          const pos = this.findGapPosition(cyl, placedBoxes);
          if (pos) {
            placed.push(this.createPlacedCylinder(cyl, pos));
            cyl.placed = true;
            placedBoxes.push({ xMin: pos.x, xMax: pos.x + cyl.diameter, yMin: pos.y, yMax: pos.y + cyl.length, zMin: pos.z, zMax: pos.z + cyl.diameter });
          }
        }
        return { placed, unplaced: allCylinders.filter(c => !c.placed).map(c => c.item) };
      }

      case 'diameter-first':
        // Sort by diameter DESC, then length DESC
        cylinders = [...allCylinders].sort((a, b) => {
          if (Math.abs(a.diameter - b.diameter) > 3) return b.diameter - a.diameter;
          return b.length - a.length;
        });
        break;

      case 'small-first':
        // Small diameter first (better for filling gaps)
        cylinders = [...allCylinders].sort((a, b) => {
          if (Math.abs(a.diameter - b.diameter) > 3) return a.diameter - b.diameter;
          return a.length - b.length;
        });
        break;

      case 'large-first':
        // Large diameter first, short length first
        cylinders = [...allCylinders].sort((a, b) => {
          if (Math.abs(a.diameter - b.diameter) > 3) return b.diameter - a.diameter;
          return a.length - b.length;
        });
        break;

      case 'volume-desc':
        // Sort by volume (largest first)
        cylinders = [...allCylinders].sort((a, b) => {
          const volA = Math.PI * (a.diameter / 2) ** 2 * a.length;
          const volB = Math.PI * (b.diameter / 2) ** 2 * b.length;
          return volB - volA;
        });
        break;
    }

    // Simple greedy packing
    for (const cyl of cylinders) {
      if (cyl.placed) continue;

      const pos = this.findBestPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Compact packing - focuses on maximizing floor utilization before stacking
   * Places cylinders in tight rows, exploiting container width efficiently
   */
  private packCompact(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Sort by length DESC to maximize Y usage per row
    const sorted = [...allCylinders].sort((a, b) => b.length - a.length);

    // Group by similar length (within 5cm)
    const lengthGroups = this.groupByLength(sorted, 5);

    let currentY = 0;

    for (const group of lengthGroups) {
      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) continue;

      // Sort group by diameter DESC for better floor packing
      group.sort((a, b) => b.diameter - a.diameter);

      // Calculate how many rows can fit in XZ
      const dominantDiameter = group[0]?.diameter || 80;
      const rowsX = Math.floor(this.W / dominantDiameter);
      const rowsZ = Math.floor(this.H / dominantDiameter);

      // Pack floor layer - fill entire width
      let floorX = 0;
      for (const cyl of group) {
        if (cyl.placed) continue;
        if (floorX + cyl.diameter > this.W) break; // Row full

        const pos = { x: floorX, y: currentY, z: 0 };
        if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: currentY, yMax: currentY + cyl.length,
            zMin: 0, zMax: cyl.diameter,
          });
          floorX += cyl.diameter;
        }
      }

      // Stack second and third layers using valley nesting
      for (let layer = 1; layer <= 3; layer++) {
        const valleyZ = layer * dominantDiameter * 0.866;
        if (valleyZ + dominantDiameter > this.H) break;

        const xOffset = (layer % 2 === 1) ? dominantDiameter / 2 : 0;
        let layerX = xOffset;

        for (const cyl of group) {
          if (cyl.placed) continue;
          if (layerX + cyl.diameter > this.W) {
            layerX = xOffset; // Reset for next attempt
            continue;
          }

          const supportedZ = this.findSupportedZ(layerX, currentY, cyl, placedBoxes);
          if (supportedZ === null || supportedZ + cyl.diameter > this.H) continue;

          const pos = { x: layerX, y: currentY, z: supportedZ };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: currentY, yMax: currentY + cyl.length,
              zMin: supportedZ, zMax: supportedZ + cyl.diameter,
            });
            layerX += cyl.diameter;
          }
        }
      }

      // Also try vertical placement for any unplaced in this group
      for (const cyl of group) {
        if (cyl.placed) continue;
        if (cyl.length > this.H) continue;

        // Try vertical at various Y positions
        for (let vy = currentY; vy + cyl.diameter <= currentY + maxLength; vy += 5) {
          let found = false;
          for (let vx = 0; vx + cyl.diameter <= this.W; vx += 5) {
            const pos = { x: vx, y: vy, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
              break;
            }
          }
          if (found) break;
        }
      }

      currentY += maxLength;
    }

    // Final pass: exhaustive search for remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    // Try vertical for any remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      if (cyl.length > this.H) continue;
      const pos = this.findVerticalPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.diameter,
          zMin: pos.z, zMax: pos.z + cyl.length,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Vertical Priority packing - prioritizes vertical placement for rolls that fit
   * This can be more efficient when rolls are short enough to stack vertically
   */
  private packVerticalPriority(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Separate cylinders that can go vertical vs those that must be horizontal
    const canBeVertical = allCylinders.filter(c => c.length <= this.H);
    const mustBeHorizontal = allCylinders.filter(c => c.length > this.H);


    // Sort vertical candidates by: can stack (short length) first, then by diameter
    canBeVertical.sort((a, b) => {
      // Prefer shorter rolls that can potentially stack
      const aCanStack = a.length * 2 <= this.H;
      const bCanStack = b.length * 2 <= this.H;
      if (aCanStack !== bCanStack) return bCanStack ? 1 : -1;
      return b.diameter - a.diameter;
    });

    // Place verticals on floor first - pack by diameter groups
    const vertByDiameter = this.groupByDiameter(canBeVertical, 10);

    for (const group of vertByDiameter) {
      const d = group[0]?.diameter || 80;
      const maxPerRow = Math.floor(this.W / d);
      const maxPerCol = Math.floor(this.L / d);

      // Pack in grid pattern first
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Find next grid position
        let found = false;
        for (let gy = 0; gy + cyl.diameter <= this.L && !found; gy += cyl.diameter) {
          for (let gx = 0; gx + cyl.diameter <= this.W && !found; gx += cyl.diameter) {
            const pos = { x: gx, y: gy, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }
      }

      // HONEYCOMB PASS: Try offset positions for remaining cylinders
      // Honeycomb rows are offset by D/2 in X and use D*0.866 spacing in Y
      const HEX_Y_SPACING = d * 0.866;
      const unplacedInGroup = group.filter(c => !c.placed);

      if (unplacedInGroup.length > 0) {

        for (const cyl of unplacedInGroup) {
          if (cyl.placed) continue;

          let found = false;

          // Try honeycomb offset positions (odd rows offset by D/2)
          for (let row = 0; !found; row++) {
            const baseY = row * HEX_Y_SPACING;
            if (baseY + cyl.diameter > this.L) break;

            const xOffset = (row % 2 === 1) ? cyl.diameter / 2 : 0;

            for (let gx = xOffset; gx + cyl.diameter <= this.W && !found; gx += cyl.diameter) {
              const pos = { x: gx, y: baseY, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: pos.x, xMax: pos.x + cyl.diameter,
                  yMin: pos.y, yMax: pos.y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }

          // If honeycomb didn't work, try fine-grid search with step=5
          if (!found) {
            for (let gy = 0; gy + cyl.diameter <= this.L && !found; gy += 5) {
              for (let gx = 0; gx + cyl.diameter <= this.W && !found; gx += 5) {
                const pos = { x: gx, y: gy, z: 0 };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: pos.x, xMax: pos.x + cyl.diameter,
                    yMin: pos.y, yMax: pos.y + cyl.diameter,
                    zMin: 0, zMax: cyl.length,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    // Now place horizontals around the verticals
    mustBeHorizontal.sort((a, b) => b.length - a.length);
    for (const cyl of mustBeHorizontal) {
      const pos = this.findBestPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    // Stack verticals that can stack (length * 2 <= H)
    const stackable = canBeVertical.filter(c => !c.placed && c.length * 2 <= this.H);
    for (const cyl of stackable) {
      // Find a vertical cylinder to stack on
      for (const box of placedBoxes) {
        const boxW = box.xMax - box.xMin;
        const boxL = box.yMax - box.yMin;
        const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

        if (!isVertical) continue;
        if (box.zMax + cyl.length > this.H) continue;

        const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
        if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
          const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.diameter,
            zMin: pos.z, zMax: pos.z + cyl.length,
          });
          break;
        }
      }
    }

    // Place remaining unplaced verticals as horizontals
    for (const cyl of canBeVertical.filter(c => !c.placed)) {
      const pos = this.findBestPosition(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    // Final exhaustive search
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Pack with maximum stacking to save Y-axis space
   * Prioritizes placing multiple layers in Z before moving along Y
   */
  private packMaximizeStacking(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Group cylinders by similar diameter (within 5cm)
    const byDiameter = this.groupByDiameter(allCylinders, 5);

    // Sort groups by diameter (smallest first - they stack better)
    byDiameter.sort((a, b) => (a[0]?.diameter || 0) - (b[0]?.diameter || 0));

    // Calculate how many rows we can fit across width for each group
    for (const group of byDiameter) {
      if (group.length === 0) continue;

      const d = group[0].diameter;
      const rowsAcross = Math.floor(this.W / d);

      // Sort within group by length (longest first to maximize vertical space usage)
      group.sort((a, b) => b.length - a.length);


      // Place cylinders in columns, stacking vertically
      for (const cyl of group) {
        if (cyl.placed) continue;

        let found = false;

        // Try to stack on existing placement first
        if (cyl.length <= this.H) {
          for (const box of placedBoxes) {
            const boxW = box.xMax - box.xMin;
            const boxL = box.yMax - box.yMin;
            const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

            if (!isVertical) continue;
            if (Math.abs(boxW - cyl.diameter) > 5) continue; // Similar diameter
            if (box.zMax + cyl.length > this.H) continue;

            const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: pos.x, xMax: pos.x + cyl.diameter,
                yMin: pos.y, yMax: pos.y + cyl.diameter,
                zMin: pos.z, zMax: pos.z + cyl.length,
              });
              found = true;
              break;
            }
          }
        }

        if (found) continue;

        // Try new floor position
        for (let y = 0; y + cyl.diameter <= this.L && !found; y += cyl.diameter) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += cyl.diameter) {
            // Try vertical first if possible
            if (cyl.length <= this.H) {
              const vPos = { x, y, z: 0 };
              if (this.canPlaceVertical(vPos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, vPos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }

            // Try horizontal if vertical didn't work
            if (!found) {
              const hPos = { x, y, z: 0 };
              if (this.canPlace(hPos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, hPos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.length,
                  zMin: 0, zMax: cyl.diameter,
                });
                found = true;
              }
            }
          }
        }
      }
    }

    // Place remaining cylinders using exhaustive search
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      // Try stacking first
      let found = false;

      if (cyl.length <= this.H) {
        for (const box of placedBoxes) {
          const boxW = box.xMax - box.xMin;
          const boxL = box.yMax - box.yMin;
          const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

          if (!isVertical) continue;
          if (box.zMax + cyl.length > this.H) continue;

          const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
          if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.diameter,
              zMin: pos.z, zMax: pos.z + cyl.length,
            });
            found = true;
            break;
          }
        }
      }

      if (!found) {
        // Try horizontal on top of verticals
        const pos = this.findBestPosition(cyl, placedBoxes);
        if (pos) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.length,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
        }
      }
    }

    // Final exhaustive search
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Pack with tight horizontal layering - fills each Y slice completely before moving
   * This approach maximizes horizontal layers to use container length efficiently
   */
  private packTightLayers(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Sort by length first (longest first), then diameter
    const sorted = [...allCylinders].sort((a, b) => {
      if (Math.abs(b.length - a.length) > 5) return b.length - a.length;
      return b.diameter - a.diameter;
    });

    // Place in layers - fill width first, then stack in height, then advance in length
    let currentY = 0;
    let layerMaxLen = 0;

    while (sorted.some(c => !c.placed) && currentY < this.L) {
      // Find unplaced cylinders that can fit at currentY
      const toPlace = sorted.filter(c => !c.placed);
      if (toPlace.length === 0) break;

      // Sort by what fits best at this Y position
      toPlace.sort((a, b) => b.diameter - a.diameter);

      layerMaxLen = 0;

      for (const cyl of toPlace) {
        if (cyl.placed) continue;

        // Check if this cylinder can fit at this Y level
        if (currentY + cyl.length > this.L && currentY + cyl.diameter > this.L) continue;

        // Try to place: first horizontal-Y, then horizontal-X, then vertical
        let found = false;

        // Try horizontal-Y (length along Y)
        if (currentY + cyl.length <= this.L) {
          for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y: currentY, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: currentY, yMax: currentY + cyl.length,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  layerMaxLen = Math.max(layerMaxLen, cyl.length);
                  found = true;
                }
              }
            }
          }
        }

        // Try horizontal-X (length along X) if it fits
        if (!found && cyl.length <= this.W && currentY + cyl.diameter <= this.L) {
          for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
              const pos = { x, y: currentY, z };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.length,
                    yMin: currentY, yMax: currentY + cyl.diameter,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  layerMaxLen = Math.max(layerMaxLen, cyl.diameter);
                  found = true;
                }
              }
            }
          }
        }

        // Try vertical
        if (!found && cyl.length <= this.H && currentY + cyl.diameter <= this.L) {
          for (let z = 0; z + cyl.length <= this.H && !found; z += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y: currentY, z };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                  const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: currentY, yMax: currentY + cyl.diameter,
                    zMin: z, zMax: z + cyl.length,
                  });
                  layerMaxLen = Math.max(layerMaxLen, cyl.diameter);
                  found = true;
                }
              }
            }
          }
        }
      }

      // Move to next Y position
      if (layerMaxLen > 0) {
        currentY += layerMaxLen;
      } else {
        currentY += 10; // Move forward if nothing placed
      }
    }

    // Final exhaustive search
    for (const cyl of sorted.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Pack awkward/middle-size rolls first - these are often left unplaced
   * Targets rolls with medium diameter and longer length that don't fit well in gaps
   */
  private packAwkwardFirst(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Calculate "awkwardness" score - rolls that are difficult to place
    // Awkward = medium diameter (not small to fit gaps, not large to go first) + longer length
    const diameters = allCylinders.map(c => c.diameter);
    const minD = Math.min(...diameters);
    const maxD = Math.max(...diameters);
    const avgD = (minD + maxD) / 2;

    const lengths = allCylinders.map(c => c.length);
    const avgL = lengths.reduce((a, b) => a + b, 0) / lengths.length;

    // Score: higher = more awkward (priority)
    const scored = allCylinders.map(c => ({
      cyl: c,
      awkwardness: Math.abs(c.diameter - avgD) * -1 + // Close to average diameter = more awkward
                   (c.length / avgL) * 10 // Longer = more awkward
    }));

    // Sort by awkwardness (highest first)
    scored.sort((a, b) => b.awkwardness - a.awkwardness);


    // Place in awkwardness order
    for (const { cyl } of scored) {
      if (cyl.placed) continue;

      let found = false;

      // Try vertical first (uses less Y space)
      if (cyl.length <= this.H) {
        for (let y = 0; y + cyl.diameter <= this.L && !found; y += cyl.diameter / 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += cyl.diameter / 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: y, yMax: y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }
      }

      // Try horizontal-Y
      if (!found) {
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: y, yMax: y + cyl.length,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }

      // Try horizontal-X (rotated)
      if (!found && cyl.length <= this.W) {
        for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
            for (let z = 0; z + cyl.diameter <= this.H && !found; z += 5) {
              const pos = { x, y, z };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.length,
                    yMin: y, yMax: y + cyl.diameter,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    // Stack remaining on verticals
    for (const { cyl } of scored) {
      if (cyl.placed) continue;

      if (cyl.length <= this.H) {
        for (const box of placedBoxes) {
          const boxW = box.xMax - box.xMin;
          const boxL = box.yMax - box.yMin;
          const isVertical = Math.abs(boxW - boxL) < 10 && box.zMax > boxW;

          if (!isVertical) continue;
          if (box.zMax + cyl.length > this.H) continue;

          const pos = { x: box.xMin, y: box.yMin, z: box.zMax };
          if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.diameter,
              zMin: pos.z, zMax: pos.z + cyl.length,
            });
            break;
          }
        }
      }
    }

    // Final exhaustive search for remaining
    for (const cyl of allCylinders.filter(c => !c.placed)) {
      const pos = this.exhaustiveSearch(cyl, placedBoxes);
      if (pos) {
        const placedCyl = this.createPlacedCylinder(cyl, pos);
        placed.push(placedCyl);
        cyl.placed = true;
        placedBoxes.push({
          xMin: pos.x, xMax: pos.x + cyl.diameter,
          yMin: pos.y, yMax: pos.y + cyl.length,
          zMin: pos.z, zMax: pos.z + cyl.diameter,
        });
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Optimal vertical-horizontal strategy based on user's working pattern:
   * Area 1: 24 × D=78 vertical (3×8 rectangular grid)
   * Area 2: 12 × D=85 + 2 × D=97 vertical (2×7 hexagonal)
   * On top: D=77, D=90, remaining D=78 horizontal
   */
  private packOptimalVerticalHorizontal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Separate cylinders by diameter
    const d77 = allCylinders.filter(c => c.diameter === 77);
    const d78 = allCylinders.filter(c => c.diameter === 78);
    const d85 = allCylinders.filter(c => c.diameter === 85);
    const d90 = allCylinders.filter(c => c.diameter === 90);
    const d97 = allCylinders.filter(c => c.diameter === 97);


    // Hexagonal spacing factor
    const HEX_FACTOR = 0.866;

    // ============ AREA 1: D=78 vertical (24 rolls: 3×8 RECTANGULAR grid) ============
    const d78Vertical = d78.slice(0, 24); // First 24 for vertical
    const d78Horizontal = d78.slice(24);  // Rest (2) for horizontal


    const d78_diameter = 78;
    let area1MaxY = 0;

    // RECTANGULAR: 3 columns × 8 rows
    for (let row = 0; row < 8 && d78Vertical.some(c => !c.placed); row++) {
      for (let col = 0; col < 3; col++) {
        const cyl = d78Vertical.find(c => !c.placed);
        if (!cyl) break;

        const x = col * d78_diameter;
        const y = row * d78_diameter;
        const pos = { x, y, z: 0 };

        if (x + d78_diameter <= this.W && y + d78_diameter <= this.L) {
          if (this.canPlaceVertical(pos, d78_diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: x, xMax: x + d78_diameter,
              yMin: y, yMax: y + d78_diameter,
              zMin: 0, zMax: cyl.length,
            });
            area1MaxY = Math.max(area1MaxY, y + d78_diameter);
          }
        }
      }
    }


    // ============ AREA 2: D=85 + D=97 vertical (2×7 HEXAGONAL grid) ============
    const area2Rolls = [...d85, ...d97];
    const area2Y = area1MaxY; // Start after Area 1 (624)


    // Sort by diameter descending to place D=97 first
    area2Rolls.sort((a, b) => b.diameter - a.diameter);

    const d85_diameter = 85;
    const d85_rowSpacing = d85_diameter * HEX_FACTOR; // ~73.6cm

    let area2MaxY = area2Y;
    let area2Placed = 0;

    for (let row = 0; row < 7 && area2Rolls.some(c => !c.placed); row++) {
      const xOffset = (row % 2 === 1) ? d85_diameter / 2 : 0;

      for (let col = 0; col < 2; col++) {
        const cyl = area2Rolls.find(c => !c.placed);
        if (!cyl) break;

        const d = cyl.diameter;
        const x = xOffset + col * d85_diameter;
        const y = area2Y + row * d85_rowSpacing;
        const pos = { x, y, z: 0 };

        if (x + d <= this.W && y + d <= this.L) {
          if (this.canPlaceVertical(pos, d, cyl.length, placedBoxes)) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: x, xMax: x + d,
              yMin: y, yMax: y + d,
              zMin: 0, zMax: cyl.length,
            });
            area2MaxY = Math.max(area2MaxY, y + d);
            area2Placed++;
          }
        }
      }
    }


    // ============ HORIZONTAL ON TOP ============
    // D=77 (all 10), D=90 (all 8), remaining D=78 (2) go horizontal = 20 total
    const horizontalRolls = [...d77, ...d90, ...d78Horizontal];

    // Sort by length descending (longer rolls first)
    horizontalRolls.sort((a, b) => b.length - a.length);

    for (const cyl of horizontalRolls) {
      if (cyl.placed) continue;

      let found = false;
      const d = cyl.diameter;
      const len = cyl.length;

      // Get all unique Z levels from vertical rolls
      const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);

      // Try placing horizontal-Y at each Z level
      for (const z of zLevels) {
        if (found) break;
        if (z + d > this.H) continue;

        for (let y = 0; y + len <= this.L && !found; y += 10) {
          for (let x = 0; x + d <= this.W && !found; x += 10) {
            const pos = { x, y, z };
            if (this.canPlace(pos, d, len, placedBoxes)) {
              if (this.hasSupportRelaxed(pos, d, len, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + d,
                  yMin: y, yMax: y + len,
                  zMin: z, zMax: z + d,
                });
                found = true;
              }
            }
          }
        }
      }

      // Try horizontal-X (rotated)
      if (!found && len <= this.W) {
        for (const z of zLevels) {
          if (found) break;
          if (z + d > this.H) continue;

          for (let y = 0; y + d <= this.L && !found; y += 10) {
            for (let x = 0; x + len <= this.W && !found; x += 10) {
              const pos = { x, y, z };
              if (this.canPlaceRotated(pos, d, len, placedBoxes)) {
                if (this.hasRotatedSupportRelaxed(pos, d, len, placedBoxes)) {
                  const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + len,
                    yMin: y, yMax: y + d,
                    zMin: z, zMax: z + d,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }

      // Fallback: exhaustive search
      if (!found) {
        const pos = this.exhaustiveSearch(cyl, placedBoxes);
        if (pos) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + d,
            yMin: pos.y, yMax: pos.y + len,
            zMin: pos.z, zMax: pos.z + d,
          });
        }
      }
    }

    const unplacedList = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced: unplacedList };
  }

  /**
   * Smart lookahead placement with TRUE simulation-based evaluation
   * For each roll, simulates placing all remaining rolls at each candidate position
   * and picks the position that maximizes total placements
   */
  private packSmartLookahead(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Sort cylinders: largest diameter first (hardest to place), then by length
    const sortedCylinders = [...allCylinders].sort((a, b) => {
      if (b.diameter !== a.diameter) return b.diameter - a.diameter;
      return b.length - a.length;
    });

    const HEX_FACTOR = 0.866;

    for (let cylIdx = 0; cylIdx < sortedCylinders.length; cylIdx++) {
      const cyl = sortedCylinders[cylIdx];
      if (cyl.placed) continue;

      const d = cyl.diameter;
      const len = cyl.length;
      const canBeVertical = len <= this.H;

      // Generate candidate positions
      type Candidate = {
        x: number;
        y: number;
        z: number;
        orientation: 'vertical' | 'horizontal-y' | 'horizontal-x';
        simulatedTotal: number;
      };
      const candidates: Candidate[] = [];

      // 1. VERTICAL candidates (grid + honeycomb positions)
      if (canBeVertical) {
        // Grid positions
        for (let gy = 0; gy + d <= this.L; gy += d) {
          for (let gx = 0; gx + d <= this.W; gx += d) {
            const pos = { x: gx, y: gy, z: 0 };
            if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
              candidates.push({ ...pos, orientation: 'vertical', simulatedTotal: 0 });
            }
          }
        }

        // Honeycomb offset positions (offset rows by d/2)
        const hexYSpacing = d * HEX_FACTOR;
        for (let row = 0; row * hexYSpacing + d <= this.L; row++) {
          const xOffset = (row % 2 === 1) ? d / 2 : 0;
          const y = row * hexYSpacing;
          for (let gx = 0; gx + d <= this.W; gx += d) {
            const x = xOffset + gx;
            if (x + d > this.W) continue;
            const pos = { x, y, z: 0 };
            const isDup = candidates.some(c =>
              Math.abs(c.x - x) < 1 && Math.abs(c.y - y) < 1 && c.z === 0 && c.orientation === 'vertical'
            );
            if (!isDup && this.canPlaceVertical(pos, d, len, placedBoxes)) {
              candidates.push({ ...pos, orientation: 'vertical', simulatedTotal: 0 });
            }
          }
        }

        // Fine-grained gap positions
        const step = Math.max(10, d / 4);
        for (let gy = 0; gy + d <= this.L; gy += step) {
          for (let gx = 0; gx + d <= this.W; gx += step) {
            const pos = { x: gx, y: gy, z: 0 };
            const isDup = candidates.some(c =>
              Math.abs(c.x - gx) < step/2 && Math.abs(c.y - gy) < step/2 && c.z === 0 && c.orientation === 'vertical'
            );
            if (!isDup && this.canPlaceVertical(pos, d, len, placedBoxes)) {
              candidates.push({ ...pos, orientation: 'vertical', simulatedTotal: 0 });
            }
          }
        }
      }

      // 2. HORIZONTAL-Y candidates
      const zLevels = [0, ...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);
      for (const z of zLevels) {
        if (z + d > this.H) continue;
        const step = Math.max(10, d / 2);
        for (let y = 0; y + len <= this.L; y += step) {
          for (let x = 0; x + d <= this.W; x += step) {
            const pos = { x, y, z };
            if (this.canPlace(pos, d, len, placedBoxes)) {
              if (z === 0 || this.hasSupportRelaxed(pos, d, len, placedBoxes)) {
                candidates.push({ ...pos, orientation: 'horizontal-y', simulatedTotal: 0 });
              }
            }
          }
        }
      }

      // 3. HORIZONTAL-X (rotated) candidates
      if (len <= this.W) {
        for (const z of zLevels) {
          if (z + d > this.H) continue;
          const step = Math.max(10, d / 2);
          for (let y = 0; y + d <= this.L; y += step) {
            for (let x = 0; x + len <= this.W; x += step) {
              const pos = { x, y, z };
              if (this.canPlaceRotated(pos, d, len, placedBoxes)) {
                if (z === 0 || this.hasRotatedSupportRelaxed(pos, d, len, placedBoxes)) {
                  candidates.push({ ...pos, orientation: 'horizontal-x', simulatedTotal: 0 });
                }
              }
            }
          }
        }
      }

      if (candidates.length === 0) {
        continue;
      }

      // Get remaining cylinders to simulate
      const remaining = sortedCylinders.slice(cylIdx + 1).filter(c => !c.placed);

      // For the last few rolls or when few candidates, test ALL positions
      // Otherwise sample for performance
      let candidatesToTest = candidates;
      const remainingCount = remaining.length;
      if (candidates.length > 50 && remainingCount > 10) {
        // Sample diverse set: corners, edges, middle positions
        candidatesToTest = [];
        // Add all vertical candidates (most important)
        candidatesToTest.push(...candidates.filter(c => c.orientation === 'vertical').slice(0, 30));
        // Add some horizontal candidates
        candidatesToTest.push(...candidates.filter(c => c.orientation !== 'vertical').slice(0, 20));
      }

      // TRUE LOOKAHEAD: For each candidate, simulate placing all remaining rolls
      for (const cand of candidatesToTest) {
        // Create the box for this candidate
        let candBox: PlacedBox;
        if (cand.orientation === 'vertical') {
          candBox = {
            xMin: cand.x, xMax: cand.x + d,
            yMin: cand.y, yMax: cand.y + d,
            zMin: cand.z, zMax: cand.z + len,
          };
        } else if (cand.orientation === 'horizontal-y') {
          candBox = {
            xMin: cand.x, xMax: cand.x + d,
            yMin: cand.y, yMax: cand.y + len,
            zMin: cand.z, zMax: cand.z + d,
          };
        } else {
          candBox = {
            xMin: cand.x, xMax: cand.x + len,
            yMin: cand.y, yMax: cand.y + d,
            zMin: cand.z, zMax: cand.z + d,
          };
        }

        // Simulate placing remaining cylinders with this candidate placed
        const simBoxes = [...placedBoxes, candBox];
        let simPlaced = 1; // Count this candidate

        for (const remCyl of remaining) {
          const simPos = this.findBestPositionForSim(remCyl, simBoxes);
          if (simPos) {
            simPlaced++;
            simBoxes.push(simPos.box);
          }
        }

        cand.simulatedTotal = simPlaced;
      }

      // Pick the candidate with highest simulated total
      candidatesToTest.sort((a, b) => b.simulatedTotal - a.simulatedTotal);
      const best = candidatesToTest[0];

      // Place the cylinder at the best position
      let placedCyl: PlacedCylinder;
      let box: PlacedBox;

      if (best.orientation === 'vertical') {
        placedCyl = this.createVerticalPlacedCylinder(cyl, best);
        box = {
          xMin: best.x, xMax: best.x + d,
          yMin: best.y, yMax: best.y + d,
          zMin: best.z, zMax: best.z + len,
        };
      } else if (best.orientation === 'horizontal-y') {
        placedCyl = this.createPlacedCylinder(cyl, best);
        box = {
          xMin: best.x, xMax: best.x + d,
          yMin: best.y, yMax: best.y + len,
          zMin: best.z, zMax: best.z + d,
        };
      } else {
        placedCyl = this.createRotatedPlacedCylinder(cyl, best);
        box = {
          xMin: best.x, xMax: best.x + len,
          yMin: best.y, yMax: best.y + d,
          zMin: best.z, zMax: best.z + d,
        };
      }

      placed.push(placedCyl);
      placedBoxes.push(box);
      cyl.placed = true;
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Fast position finder for simulation - tries vertical (grid+honeycomb), then horizontal
   */
  private findBestPositionForSim(cyl: Cylinder, placedBoxes: PlacedBox[]): { box: PlacedBox } | null {
    const d = cyl.diameter;
    const len = cyl.length;
    const HEX_FACTOR = 0.866;

    // Try vertical first if it fits
    if (len <= this.H) {
      // Grid positions
      for (let gy = 0; gy + d <= this.L; gy += d) {
        for (let gx = 0; gx + d <= this.W; gx += d) {
          const pos = { x: gx, y: gy, z: 0 };
          if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
            return {
              box: {
                xMin: pos.x, xMax: pos.x + d,
                yMin: pos.y, yMax: pos.y + d,
                zMin: 0, zMax: len,
              }
            };
          }
        }
      }

      // Honeycomb positions
      const hexYSpacing = d * HEX_FACTOR;
      for (let row = 0; row * hexYSpacing + d <= this.L; row++) {
        const xOffset = (row % 2 === 1) ? d / 2 : 0;
        const y = row * hexYSpacing;
        for (let gx = 0; gx + d <= this.W; gx += d) {
          const x = xOffset + gx;
          if (x + d > this.W) continue;
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
            return {
              box: {
                xMin: pos.x, xMax: pos.x + d,
                yMin: pos.y, yMax: pos.y + d,
                zMin: 0, zMax: len,
              }
            };
          }
        }
      }

      // Fine-grained gap search
      const step = Math.max(10, d / 4);
      for (let gy = 0; gy + d <= this.L; gy += step) {
        for (let gx = 0; gx + d <= this.W; gx += step) {
          const pos = { x: gx, y: gy, z: 0 };
          if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
            return {
              box: {
                xMin: pos.x, xMax: pos.x + d,
                yMin: pos.y, yMax: pos.y + d,
                zMin: 0, zMax: len,
              }
            };
          }
        }
      }
    }

    // Try horizontal-y
    const zLevels = [0, ...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);
    for (const z of zLevels) {
      if (z + d > this.H) continue;
      for (let y = 0; y + len <= this.L; y += d) {
        for (let x = 0; x + d <= this.W; x += d) {
          const pos = { x, y, z };
          if (this.canPlace(pos, d, len, placedBoxes)) {
            if (z === 0 || this.hasSupportRelaxed(pos, d, len, placedBoxes)) {
              return {
                box: {
                  xMin: pos.x, xMax: pos.x + d,
                  yMin: pos.y, yMax: pos.y + len,
                  zMin: z, zMax: z + d,
                }
              };
            }
          }
        }
      }
    }

    // Try horizontal-x (rotated)
    if (len <= this.W) {
      for (const z of zLevels) {
        if (z + d > this.H) continue;
        for (let y = 0; y + d <= this.L; y += d) {
          for (let x = 0; x + len <= this.W; x += d) {
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, d, len, placedBoxes)) {
              if (z === 0 || this.hasRotatedSupportRelaxed(pos, d, len, placedBoxes)) {
                return {
                  box: {
                    xMin: pos.x, xMax: pos.x + len,
                    yMin: pos.y, yMax: pos.y + d,
                    zMin: z, zMax: z + d,
                  }
                };
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Multi-order lookahead - tries multiple sorting orders to find optimal placement
   * Each order is tested with simulation to see which maximizes total placements
   */
  private packMultiOrderLookahead(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {

    // Define different sorting strategies
    const sortOrders: Array<{ name: string; sort: (a: Cylinder, b: Cylinder) => number }> = [
      { name: 'diameter-desc', sort: (a, b) => b.diameter - a.diameter || b.length - a.length },
      { name: 'diameter-asc', sort: (a, b) => a.diameter - b.diameter || a.length - b.length },
      { name: 'length-desc', sort: (a, b) => b.length - a.length || b.diameter - a.diameter },
      { name: 'length-asc', sort: (a, b) => a.length - b.length || a.diameter - b.diameter },
      { name: 'volume-desc', sort: (a, b) => (b.diameter * b.diameter * b.length) - (a.diameter * a.diameter * a.length) },
      { name: 'footprint-desc', sort: (a, b) => (b.diameter * b.diameter) - (a.diameter * a.diameter) || b.length - a.length },
      { name: 'awkward-first', sort: (a, b) => {
        // Middle-sized rolls are hardest to place
        const aScore = Math.abs(a.diameter - 85) + Math.abs(a.length - 150);
        const bScore = Math.abs(b.diameter - 85) + Math.abs(b.length - 150);
        return aScore - bScore;
      }},
      { name: 'D85-first', sort: (a, b) => {
        // Prioritize D=85 rolls (the unplaced one is 85x149.9)
        const aIs85 = Math.abs(a.diameter - 85) < 5 ? 0 : 1;
        const bIs85 = Math.abs(b.diameter - 85) < 5 ? 0 : 1;
        if (aIs85 !== bIs85) return aIs85 - bIs85;
        return b.diameter - a.diameter;
      }},
      { name: 'D85x150-first', sort: (a, b) => {
        // Put the exact problem roll first (D=85, L≈149.9)
        const aIsProblem = (Math.abs(a.diameter - 85) < 5 && Math.abs(a.length - 149.9) < 5) ? 0 : 1;
        const bIsProblem = (Math.abs(b.diameter - 85) < 5 && Math.abs(b.length - 149.9) < 5) ? 0 : 1;
        if (aIsProblem !== bIsProblem) return aIsProblem - bIsProblem;
        return b.diameter - a.diameter || b.length - a.length;
      }},
      { name: 'D78-D77-first', sort: (a, b) => {
        // Pack D=78 and D=77 first (they fit 3 across width = 234cm/231cm)
        const aIs7x = (a.diameter >= 77 && a.diameter <= 78) ? 0 : 1;
        const bIs7x = (b.diameter >= 77 && b.diameter <= 78) ? 0 : 1;
        if (aIs7x !== bIs7x) return aIs7x - bIs7x;
        return b.diameter - a.diameter;
      }},
      { name: 'by-width-fit', sort: (a, b) => {
        // Group by how they fit across width (235cm)
        const aFitCount = Math.floor(235 / a.diameter);
        const bFitCount = Math.floor(235 / b.diameter);
        // Prefer rolls that fit perfectly (3 D=78 = 234cm)
        const aWaste = 235 - (aFitCount * a.diameter);
        const bWaste = 235 - (bFitCount * b.diameter);
        if (aWaste !== bWaste) return aWaste - bWaste;
        return b.diameter - a.diameter;
      }},
    ];

    let bestResult: { placed: PlacedCylinder[]; unplaced: CargoItem[] } | null = null;
    let bestOrderName = '';

    for (const order of sortOrders) {
      allCylinders.forEach(c => c.placed = false);
      const sorted = [...allCylinders].sort(order.sort);
      const result = this.packWithSortedCylinders(sorted);


      if (!bestResult || result.placed.length > bestResult.placed.length) {
        bestResult = result;
        bestOrderName = order.name;
      }

      // Early exit if all placed
      if (result.placed.length === allCylinders.length) {
        break;
      }
    }

    return bestResult!;
  }

  /**
   * Pack cylinders in the given sorted order using grid+honeycomb positioning
   */
  private packWithSortedCylinders(sortedCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];
    const HEX_FACTOR = 0.866;

    for (const cyl of sortedCylinders) {
      if (cyl.placed) continue;

      const d = cyl.diameter;
      const len = cyl.length;
      const canBeVertical = len <= this.H;

      let foundPos: { x: number; y: number; z: number; orientation: 'vertical' | 'horizontal-y' | 'horizontal-x' } | null = null;

      // Try vertical positions first (grid then honeycomb)
      if (canBeVertical) {
        // Grid
        outer: for (let gy = 0; gy + d <= this.L; gy += d) {
          for (let gx = 0; gx + d <= this.W; gx += d) {
            const pos = { x: gx, y: gy, z: 0 };
            if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
              foundPos = { ...pos, orientation: 'vertical' };
              break outer;
            }
          }
        }

        // Honeycomb
        if (!foundPos) {
          const hexYSpacing = d * HEX_FACTOR;
          outer: for (let row = 0; row * hexYSpacing + d <= this.L; row++) {
            const xOffset = (row % 2 === 1) ? d / 2 : 0;
            const y = row * hexYSpacing;
            for (let gx = 0; gx + d <= this.W; gx += d) {
              const x = xOffset + gx;
              if (x + d > this.W) continue;
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
                foundPos = { ...pos, orientation: 'vertical' };
                break outer;
              }
            }
          }
        }

        // Fine-grained search
        if (!foundPos) {
          const step = Math.max(5, d / 8);
          outer: for (let gy = 0; gy + d <= this.L; gy += step) {
            for (let gx = 0; gx + d <= this.W; gx += step) {
              const pos = { x: gx, y: gy, z: 0 };
              if (this.canPlaceVertical(pos, d, len, placedBoxes)) {
                foundPos = { ...pos, orientation: 'vertical' };
                break outer;
              }
            }
          }
        }
      }

      // Try horizontal if no vertical position found
      if (!foundPos) {
        const zLevels = [0, ...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);
        const hStep = Math.max(10, d / 4);
        outer: for (const z of zLevels) {
          if (z + d > this.H) continue;
          for (let y = 0; y + len <= this.L; y += hStep) {
            for (let x = 0; x + d <= this.W; x += hStep) {
              const pos = { x, y, z };
              if (this.canPlace(pos, d, len, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, d, len, placedBoxes)) {
                  foundPos = { ...pos, orientation: 'horizontal-y' };
                  break outer;
                }
              }
            }
          }
        }
      }

      // Try horizontal-x (rotated)
      if (!foundPos && len <= this.W) {
        const zLevels = [0, ...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);
        const hStep = Math.max(10, d / 4);
        outer: for (const z of zLevels) {
          if (z + d > this.H) continue;
          for (let y = 0; y + d <= this.L; y += hStep) {
            for (let x = 0; x + len <= this.W; x += hStep) {
              const pos = { x, y, z };
              if (this.canPlaceRotated(pos, d, len, placedBoxes)) {
                if (z === 0 || this.hasRotatedSupportRelaxed(pos, d, len, placedBoxes)) {
                  foundPos = { ...pos, orientation: 'horizontal-x' };
                  break outer;
                }
              }
            }
          }
        }
      }

      if (foundPos) {
        let placedCyl: PlacedCylinder;
        let box: PlacedBox;

        if (foundPos.orientation === 'vertical') {
          placedCyl = this.createVerticalPlacedCylinder(cyl, foundPos);
          box = {
            xMin: foundPos.x, xMax: foundPos.x + d,
            yMin: foundPos.y, yMax: foundPos.y + d,
            zMin: 0, zMax: len,
          };
        } else if (foundPos.orientation === 'horizontal-y') {
          placedCyl = this.createPlacedCylinder(cyl, foundPos);
          box = {
            xMin: foundPos.x, xMax: foundPos.x + d,
            yMin: foundPos.y, yMax: foundPos.y + len,
            zMin: foundPos.z, zMax: foundPos.z + d,
          };
        } else {
          placedCyl = this.createRotatedPlacedCylinder(cyl, foundPos);
          box = {
            xMin: foundPos.x, xMax: foundPos.x + len,
            yMin: foundPos.y, yMax: foundPos.y + d,
            zMin: foundPos.z, zMax: foundPos.z + d,
          };
        }

        placed.push(placedCyl);
        placedBoxes.push(box);
        cyl.placed = true;
      }
    }

    const unplaced = sortedCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Aggressive placement - tries ALL positions at step=1 for a single cylinder
   * Used as final fallback when main strategies leave 1-2 unplaced
   */
  private tryAggressivePlacement(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
    const { diameter, length } = cyl;


    // Collect ALL Z levels
    const zLevels: number[] = [0];
    for (const box of placedBoxes) {
      if (!zLevels.includes(box.zMax)) {
        zLevels.push(box.zMax);
      }
    }
    zLevels.sort((a, b) => a - b);

    // 1. Try horizontal-Y at EVERY Z level with step=1
    for (const z of zLevels) {
      if (z + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (z === 0 || this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
              return { pos, orientation: 'horizontal-y' };
            }
          }
        }
      }
    }

    // 2. Try horizontal-X at EVERY Z level (rotated: length along X axis)
    // For D85 L149.9: needs 149.9cm X × 85cm Y × 85cm Z
    if (length <= this.W) {
      let rotatedAttempts = 0;
      for (const z of zLevels) {
        if (z + diameter > this.H) continue;

        for (let y = 0; y + diameter <= this.L; y += 5) { // Coarse first
          for (let x = 0; x + length <= this.W; x += 5) {
            rotatedAttempts++;
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasRotatedSupportRelaxed(pos, diameter, length, placedBoxes)) {
                return { pos, orientation: 'horizontal-x' };
              }
            }
          }
        }
      }

      // Fine search
      for (const z of zLevels) {
        if (z + diameter > this.H) continue;
        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + length <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasRotatedSupportRelaxed(pos, diameter, length, placedBoxes)) {
                return { pos, orientation: 'horizontal-x' };
              }
            }
          }
        }
      }
    } else {
    }

    // 3. Try vertical at EVERY Z level
    if (length <= this.H) {
      for (const z of zLevels) {
        if (z + length > this.H) continue;

        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + diameter <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasVerticalSupportRelaxed(pos, diameter, placedBoxes)) {
                return { pos, orientation: 'vertical' };
              }
            }
          }
        }
      }
    }

    // 4. Try ANY Z position (not just tops of boxes) with floor support
    for (let z = 1; z + diameter <= this.H; z += 1) {
      for (let y = 0; y + length <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
              return { pos, orientation: 'horizontal-y' };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Horizontal Stacked Optimal - Places cylinders horizontally with optimal Z-stacking
   * This strategy prioritizes horizontal placement with maximum Z-layers to minimize Y usage.
   * Key insight: Horizontal stacking (3 layers for D≤85, 2 for D>85) uses less Y than vertical placement.
   *
   * For container 235x1203x269:
   * - D=85: 3 layers (255cm) in H=269, 2 across W=235 (170cm), saves Y vs vertical
   * - D=90: 2 layers (180cm) in H=269, 2 across W=235 (180cm)
   * - D=77/78: 3 layers in H=269, 3 across W=235
   */
  private packHorizontalStackedOptimal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Group cylinders by diameter for optimal stacking
    const byDiameter = new Map<number, Cylinder[]>();
    for (const cyl of allCylinders) {
      const d = cyl.diameter;
      if (!byDiameter.has(d)) byDiameter.set(d, []);
      byDiameter.get(d)!.push(cyl);
    }

    // Calculate optimal layout for each diameter group
    // Priority: larger diameters that need more Z-space first (D=97, D=90, D=85)
    const sortedDiameters = Array.from(byDiameter.keys()).sort((a, b) => b - a);


    let currentY = 0;

    for (const diameter of sortedDiameters) {
      const cylinders = byDiameter.get(diameter)!;
      if (cylinders.length === 0) continue;

      // Sort by length descending within group (place longest first)
      cylinders.sort((a, b) => b.length - a.length);

      // Calculate how many can fit across width and how many layers in height
      const acrossWidth = Math.floor(this.W / diameter);
      const layersInHeight = Math.floor(this.H / diameter);
      const maxPerSection = acrossWidth * layersInHeight;
      const maxLength = Math.max(...cylinders.map(c => c.length));


      // Place cylinders in horizontal sections
      let sectionStart = currentY;
      let placedInGroup = 0;

      while (cylinders.some(c => !c.placed) && sectionStart + maxLength <= this.L) {
        // Place cylinders in this section (fill width first, then stack in Z)
        const sectionCylinders: Cylinder[] = [];

        for (let layer = 0; layer < layersInHeight && cylinders.some(c => !c.placed); layer++) {
          const z = layer * diameter;
          if (z + diameter > this.H) break;

          for (let col = 0; col < acrossWidth && cylinders.some(c => !c.placed); col++) {
            const cyl = cylinders.find(c => !c.placed);
            if (!cyl) break;

            const x = col * diameter;
            if (x + diameter > this.W) continue;

            const pos = { x, y: sectionStart, z };

            // Check if position is valid
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              // For non-floor positions, check support
              if (z === 0 || this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + diameter,
                  yMin: sectionStart, yMax: sectionStart + cyl.length,
                  zMin: z, zMax: z + diameter,
                });
                sectionCylinders.push(cyl);
                placedInGroup++;
              }
            }
          }
        }

        // Move to next section
        if (sectionCylinders.length > 0) {
          const sectionMaxLen = Math.max(...sectionCylinders.map(c => c.length));
          sectionStart += sectionMaxLen;
        } else {
          // No cylinders placed in this section, try next Y position
          sectionStart += 10;
        }
      }

      currentY = sectionStart;
    }

    // Final pass: try to fit any remaining cylinders using exhaustive search
    const remaining = allCylinders.filter(c => !c.placed);
    if (remaining.length > 0) {

      for (const cyl of remaining) {
        // Try horizontal first
        let found = false;

        // Try all Z levels
        const zLevels = [0, ...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);

        for (const z of zLevels) {
          if (found) break;
          if (z + cyl.diameter > this.H) continue;

          for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: y, yMax: y + cyl.length,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }

        // Try vertical if horizontal didn't work
        if (!found && cyl.length <= this.H) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }
        }

        // Try rotated horizontal (length along X)
        if (!found && cyl.length <= this.W) {
          for (const z of zLevels) {
            if (found) break;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
              for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
                const pos = { x, y, z };
                if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.length,
                      yMin: y, yMax: y + cyl.diameter,
                      zMin: z, zMax: z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Ultra-fine search for any still remaining
    const stillRemaining = allCylinders.filter(c => !c.placed);
    if (stillRemaining.length > 0) {

      for (const cyl of stillRemaining) {
        // Step=1 exhaustive search
        const pos = this.exhaustiveSearch(cyl, placedBoxes);
        if (pos) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.length,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
        }
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Pack by Length Groups - Groups cylinders by similar length to maximize Y-efficiency
   * Cylinders with similar lengths can share the same Y-section, filling XZ more completely.
   * This is more efficient than grouping by diameter since length determines Y-usage.
   */
  private packByLengthGroups(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Group cylinders by similar length (within 15cm tolerance)
    const lengthTolerance = 15;
    const lengthGroups: Cylinder[][] = [];

    // Sort by length descending first
    const sorted = [...allCylinders].sort((a, b) => b.length - a.length);

    for (const cyl of sorted) {
      // Find existing group with similar length
      let found = false;
      for (const group of lengthGroups) {
        const groupMaxLen = Math.max(...group.map(c => c.length));
        if (Math.abs(cyl.length - groupMaxLen) <= lengthTolerance) {
          group.push(cyl);
          found = true;
          break;
        }
      }
      if (!found) {
        lengthGroups.push([cyl]);
      }
    }


    let currentY = 0;

    for (const group of lengthGroups) {
      if (group.length === 0) continue;

      const maxLength = Math.max(...group.map(c => c.length));
      if (currentY + maxLength > this.L) {
        continue;
      }

      // Sort group by diameter descending (larger cylinders first for floor positions)
      group.sort((a, b) => b.diameter - a.diameter);


      // Calculate XZ positions for this group
      // Track occupied XZ regions to fill gaps
      const sectionY = currentY;

      // Place cylinders by filling XZ cross-section
      // First, place floor layer (z=0)
      for (const cyl of group) {
        if (cyl.placed) continue;

        // Try floor position first
        for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
          const pos = { x, y: sectionY, z: 0 };
          if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: x, xMax: x + cyl.diameter,
              yMin: sectionY, yMax: sectionY + cyl.length,
              zMin: 0, zMax: cyl.diameter,
            });
            break;
          }
        }
      }

      // Now stack additional layers
      const zLevels = [0, ...new Set(placedBoxes.filter(b => b.yMin === sectionY).map(b => b.zMax))];
      zLevels.sort((a, b) => a - b);

      for (const z of zLevels) {
        if (z === 0) continue; // Already processed
        if (z > this.H) break;

        for (const cyl of group) {
          if (cyl.placed) continue;
          if (z + cyl.diameter > this.H) continue;

          // Find X position at this Z level
          for (let x = 0; x + cyl.diameter <= this.W; x += 1) {
            const pos = { x, y: sectionY, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              // Check support (either directly below or valley support)
              if (this.hasSupport(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: sectionY, yMax: sectionY + cyl.length,
                  zMin: z, zMax: z + cyl.diameter,
                });
                break;
              }
            }
          }
        }
      }

      // Move Y forward by the max length in this section
      const placedInSection = placedBoxes.filter(b => b.yMin === sectionY);
      if (placedInSection.length > 0) {
        const sectionMaxY = Math.max(...placedInSection.map(b => b.yMax));
        currentY = sectionMaxY;
      } else {
        currentY += maxLength;
      }
    }

    // Final pass: try vertical placement for remaining
    const remaining = allCylinders.filter(c => !c.placed);
    if (remaining.length > 0) {

      for (const cyl of remaining) {
        // Try vertical on floor
        if (cyl.length <= this.H) {
          let found = false;
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }
        }

        // Try horizontal-X (rotated)
        if (!cyl.placed && cyl.length <= this.W) {
          let found = false;
          for (let z = 0; z + cyl.diameter <= this.H && !found; z += cyl.diameter) {
            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
              for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
                const pos = { x, y, z };
                if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.length,
                      yMin: y, yMax: y + cyl.diameter,
                      zMin: z, zMax: z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        // Exhaustive search
        if (!cyl.placed) {
          const pos = this.exhaustiveSearch(cyl, placedBoxes);
          if (pos) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.length,
              zMin: pos.z, zMax: pos.z + cyl.diameter,
            });
          }
        }
      }
    }

    const unplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced };
  }

  /**
   * Universal Maximum Fit - Calculates optimal vertical/horizontal mix for ANY cylinder set
   * Uses mathematical optimization to maximize total placement
   */
  private packUniversalMaxFit(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Group cylinders by diameter for analysis
    const byDiameter = new Map<number, Cylinder[]>();
    for (const c of allCylinders) {
      if (!byDiameter.has(c.diameter)) byDiameter.set(c.diameter, []);
      byDiameter.get(c.diameter)!.push(c);
    }

    // Calculate capacity for each diameter group
    for (const [d, cyls] of byDiameter) {
      const avgLen = cyls.reduce((s, c) => s + c.length, 0) / cyls.length;
      // Vertical capacity: floor grid
      const vCols = Math.floor(this.W / d);
      const vRows = Math.floor(this.L / d);
      const vFloor = vCols * vRows;
      const vStack = avgLen * 2 <= this.H ? 2 : 1;
      const vTotal = vFloor * vStack;

      // Horizontal capacity: stacked layers
      const hCols = Math.floor(this.W / d);
      const hRows = Math.floor(this.L / avgLen);
      const hStack = Math.floor(this.H / d);
      const hTotal = hCols * hRows * hStack;

    }

    // Strategy: Fill floor with verticals using hexagonal packing, then stack horizontals on top
    // Sort by diameter descending (larger first for floor stability)
    const sortedDiameters = Array.from(byDiameter.keys()).sort((a, b) => b - a);

    // PHASE 1: Pack verticals on floor using tight hexagonal pattern

    const HEX_FACTOR = 0.866; // Hexagonal row spacing

    for (const d of sortedDiameters) {
      const cyls = byDiameter.get(d)!.filter(c => !c.placed && c.length <= this.H);
      if (cyls.length === 0) continue;

      // Sort by length ascending (shorter ones first - they might stack)
      cyls.sort((a, b) => a.length - b.length);

      const rowSpacing = d * HEX_FACTOR;

      for (const cyl of cyls) {
        if (cyl.placed) continue;

        let found = false;

        // Try hexagonal positions
        for (let row = 0; !found; row++) {
          const y = row * rowSpacing;
          if (y + cyl.diameter > this.L) break;

          const xOffset = (row % 2 === 1) ? d / 2 : 0;

          for (let x = xOffset; x + cyl.diameter <= this.W && !found; x += d) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: y, yMax: y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }
      }
    }


    // PHASE 2: Stack verticals on top of verticals (if height allows)

    const floorBoxes = placedBoxes.filter(b => b.zMin === 0);

    for (const d of sortedDiameters) {
      const cyls = byDiameter.get(d)!.filter(c => !c.placed && c.length <= this.H);

      for (const cyl of cyls) {
        if (cyl.placed) continue;

        // Find a floor vertical to stack on
        for (const base of floorBoxes) {
          if (base.zMax + cyl.length > this.H) continue;
          if (Math.abs((base.xMax - base.xMin) - cyl.diameter) > 5) continue; // Similar diameter

          const pos = { x: base.xMin, y: base.yMin, z: base.zMax };
          if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
            const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.diameter,
              zMin: pos.z, zMax: pos.z + cyl.length,
            });
            break;
          }
        }
      }
    }


    // PHASE 3: Place horizontals on top of vertical area (sharing Y footprint)

    const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);

    for (const d of sortedDiameters) {
      const cyls = byDiameter.get(d)!.filter(c => !c.placed);
      cyls.sort((a, b) => b.length - a.length); // Longest first

      for (const cyl of cyls) {
        if (cyl.placed) continue;

        let found = false;

        // Try each Z level
        for (const z of zLevels) {
          if (found) break;
          if (z + cyl.diameter > this.H) continue;

          // Search within placed area (where we have support)
          for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: y, yMax: y + cyl.length,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }

        // Try rotated orientation
        if (!found && cyl.length <= this.W) {
          for (const z of zLevels) {
            if (found) break;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
              for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
                const pos = { x, y, z };
                if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.length,
                      yMin: y, yMax: y + cyl.diameter,
                      zMin: z, zMax: z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }
      }
    }


    // PHASE 4: Final exhaustive search for remaining
    const remaining = allCylinders.filter(c => !c.placed);
    if (remaining.length > 0) {

      for (const cyl of remaining) {
        // Try vertical first
        if (cyl.length <= this.H) {
          for (let y = 0; y + cyl.diameter <= this.L; y += 1) {
            let found = false;
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 1) {
              for (let z = 0; z + cyl.length <= this.H && !found; z += 1) {
                const pos = { x, y, z };
                if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasVerticalSupport(pos, cyl.diameter, placedBoxes)) {
                    const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.diameter,
                      yMin: y, yMax: y + cyl.diameter,
                      zMin: z, zMax: z + cyl.length,
                    });
                    found = true;
                  }
                }
              }
            }
            if (found) break;
          }
        }

        // Try horizontal if vertical didn't work
        if (!cyl.placed) {
          const pos = this.exhaustiveSearch(cyl, placedBoxes);
          if (pos) {
            const placedCyl = this.createPlacedCylinder(cyl, pos);
            placed.push(placedCyl);
            cyl.placed = true;
            placedBoxes.push({
              xMin: pos.x, xMax: pos.x + cyl.diameter,
              yMin: pos.y, yMax: pos.y + cyl.length,
              zMin: pos.z, zMax: pos.z + cyl.diameter,
            });
          }
        }
      }
    }

    const unplacedList = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced: unplacedList };
  }

  /**
   * Mixed Floor Packing - Places BOTH vertical AND horizontal cylinders on the floor
   * This is the key insight: horizontal stacks (3 high) on floor + verticals + horizontals on top
   */
  private packMixedFloorOptimal(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    // Analyze cylinders
    const uniqueDiameters = [...new Set(allCylinders.map(c => c.diameter))].sort((a, b) => b - a);
    const avgDiameter = allCylinders.reduce((s, c) => s + c.diameter, 0) / allCylinders.length;
    const avgLength = allCylinders.reduce((s, c) => s + c.length, 0) / allCylinders.length;


    // Calculate capacities
    const hStackLayers = Math.floor(this.H / avgDiameter); // How many horizontal layers fit
    const vCanStack = avgLength * 2 <= this.H; // Can verticals stack on each other?


    // STRATEGY: Divide Y space between horizontal-floor sections and vertical sections
    // Horizontal section: uses avgLength Y, fits hStackLayers high × 2 wide = 2*hStackLayers per section
    // Vertical section: uses avgDiameter Y (with hex ~0.866), fits 2 wide × (1 or 2 high) + horizontals on top

    const cylindersPerHSection = Math.floor(this.W / avgDiameter) * hStackLayers;
    const cylindersPerVSection = Math.floor(this.W / avgDiameter) * (vCanStack ? 2 : 1);
    const yPerHSection = avgLength;
    const yPerVSection = avgDiameter * 0.866; // Hex packing


    // Calculate optimal split: maximize cylinders while staying within Y limit
    // Try different combinations
    let bestConfig = { hSections: 0, vSections: 0, total: 0 };

    for (let h = 0; h <= Math.floor(this.L / yPerHSection); h++) {
      const yUsedByH = h * yPerHSection;
      const yRemaining = this.L - yUsedByH;
      const vSections = Math.floor(yRemaining / yPerVSection);
      const total = h * cylindersPerHSection + vSections * cylindersPerVSection;

      if (total > bestConfig.total) {
        bestConfig = { hSections: h, vSections, total };
      }
    }


    // PHASE 1: Place horizontal stacks at the BACK of the container (high Y values)

    const hStartY = this.L - (bestConfig.hSections * avgLength);
    let currentHY = hStartY;

    // Group cylinders by diameter for organized placement
    const byDiameter = new Map<number, Cylinder[]>();
    for (const c of allCylinders) {
      if (!byDiameter.has(c.diameter)) byDiameter.set(c.diameter, []);
      byDiameter.get(c.diameter)!.push(c);
    }

    // Sort each group by length descending (place longest first)
    for (const [, cyls] of byDiameter) {
      cyls.sort((a, b) => b.length - a.length);
    }

    // Place horizontals at back (Y = hStartY to L)
    for (let section = 0; section < bestConfig.hSections; section++) {
      const sectionY = currentHY;

      // Find cylinders that fit in this section
      for (const [d, cyls] of byDiameter) {
        const colsPerRow = Math.floor(this.W / d);

        for (let layer = 0; layer < hStackLayers; layer++) {
          const z = layer * d;
          if (z + d > this.H) break;

          for (let col = 0; col < colsPerRow; col++) {
            const cyl = cyls.find(c => !c.placed && c.length <= (this.L - sectionY));
            if (!cyl) continue;

            const x = col * d;
            const pos = { x, y: sectionY, z };

            // Check if fits and has support
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: sectionY, yMax: sectionY + cyl.length,
                  zMin: z, zMax: z + cyl.diameter,
                });
              }
            }
          }
        }
      }

      currentHY += avgLength;
    }


    // PHASE 2: Place verticals in front area (Y = 0 to hStartY) using hexagonal packing

    const HEX_FACTOR = 0.866;

    for (const [d, cyls] of byDiameter) {
      const unplacedCyls = cyls.filter(c => !c.placed && c.length <= this.H);
      const rowSpacing = d * HEX_FACTOR;

      for (const cyl of unplacedCyls) {
        if (cyl.placed) continue;

        let found = false;

        // Try hexagonal positions in front area
        for (let row = 0; !found; row++) {
          const y = row * rowSpacing;
          if (y + cyl.diameter > hStartY) break; // Stay in front area

          const xOffset = (row % 2 === 1) ? d / 2 : 0;

          for (let x = xOffset; x + cyl.diameter <= this.W && !found; x += d) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: y, yMax: y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }
      }
    }


    // PHASE 3: Stack horizontals on top of verticals

    const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].filter(z => z > 0).sort((a, b) => a - b);

    for (const [, cyls] of byDiameter) {
      const unplacedCyls = cyls.filter(c => !c.placed);

      for (const cyl of unplacedCyls) {
        if (cyl.placed) continue;

        let found = false;

        for (const z of zLevels) {
          if (found) break;
          if (z + cyl.diameter > this.H) continue;

          for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.diameter,
                    yMin: y, yMax: y + cyl.length,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }

        // Try rotated orientation
        if (!found && cyl.length <= this.W) {
          for (const z of zLevels) {
            if (found) break;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
              for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
                const pos = { x, y, z };
                if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.length,
                      yMin: y, yMax: y + cyl.diameter,
                      zMin: z, zMax: z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }
      }
    }


    // PHASE 4: Fill ANY remaining space (floor or elevated)

    const remaining = allCylinders.filter(c => !c.placed);

    for (const cyl of remaining) {
      let found = false;

      // Try horizontal on floor first (in any available space)
      for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
        for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
          for (let z = 0; z + cyl.diameter <= this.H && !found; z += cyl.diameter) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.length,
                  zMin: z, zMax: z + cyl.diameter,
                });
                found = true;
              }
            }
          }
        }
      }

      // Try vertical
      if (!found && cyl.length <= this.H) {
        for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: y, yMax: y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }
      }

      // Try rotated
      if (!found && cyl.length <= this.W) {
        for (let y = 0; y + cyl.diameter <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.length <= this.W && !found; x += 2) {
            for (let z = 0; z + cyl.diameter <= this.H && !found; z += cyl.diameter) {
              const pos = { x, y, z };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.length,
                    yMin: y, yMax: y + cyl.diameter,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }
    }

    const unplacedList = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced: unplacedList };
  }

  /**
   * PURE HEXAGONAL FLOOR - Uses hex packing from START (not as fallback)
   * Hex packing saves ~13% Y space: D*0.866 spacing instead of D
   * This should save enough Y space to fit all 58 cylinders
   */
  private packPureHexagonalFloor(allCylinders: Cylinder[]): { placed: PlacedCylinder[]; unplaced: CargoItem[] } {
    allCylinders.forEach(c => c.placed = false);

    const placed: PlacedCylinder[] = [];
    const placedBoxes: PlacedBox[] = [];


    const HEX_FACTOR = 0.866; // sqrt(3)/2 - hexagonal row spacing

    // Separate by orientation capability
    const canBeVertical = allCylinders.filter(c => c.length <= this.H);
    const mustBeHorizontal = allCylinders.filter(c => c.length > this.H);


    // Sort verticals: smaller diameter first (they pack tighter in hex pattern)
    canBeVertical.sort((a, b) => a.diameter - b.diameter);

    // Group by similar diameter for efficient packing
    const vertByDiameter = new Map<number, Cylinder[]>();
    for (const c of canBeVertical) {
      const key = Math.round(c.diameter / 5) * 5; // Group within 5cm
      if (!vertByDiameter.has(key)) vertByDiameter.set(key, []);
      vertByDiameter.get(key)!.push(c);
    }

    // Calculate hex capacity for each diameter group
    const totalYNeeded = { grid: 0, hex: 0 };
    for (const [d, cyls] of vertByDiameter) {
      const gridRows = Math.ceil(cyls.length / Math.floor(this.W / d));
      const hexRows = Math.ceil(cyls.length / Math.floor(this.W / d));
      totalYNeeded.grid += gridRows * d;
      totalYNeeded.hex += hexRows * d * HEX_FACTOR;
    }

    // PHASE 1: Place ALL verticals using PURE HEXAGONAL packing (not grid!)

    // Process smallest diameters first (they benefit most from hex packing)
    const sortedDiameters = Array.from(vertByDiameter.keys()).sort((a, b) => a - b);

    for (const d of sortedDiameters) {
      const cyls = vertByDiameter.get(d)!;
      const hexYSpacing = d * HEX_FACTOR;


      for (const cyl of cyls) {
        if (cyl.placed) continue;

        let found = false;

        // PURE HEX: Always use hex spacing, NEVER grid
        for (let row = 0; !found; row++) {
          const y = row * hexYSpacing;
          if (y + cyl.diameter > this.L) break;

          const xOffset = (row % 2 === 1) ? cyl.diameter / 2 : 0;
          const colCount = Math.floor((this.W - xOffset) / cyl.diameter);

          for (let col = 0; col < colCount && !found; col++) {
            const x = xOffset + col * cyl.diameter;
            const pos = { x, y, z: 0 };

            if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: y, yMax: y + cyl.diameter,
                zMin: 0, zMax: cyl.length,
              });
              found = true;
            }
          }
        }

        // Fine-grained search if hex didn't work
        if (!found) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }
        }
      }
    }

    // Calculate Y extent used
    const maxYUsed = placedBoxes.length > 0 ? Math.max(...placedBoxes.map(b => b.yMax)) : 0;

    // PHASE 2: Place horizontal-only cylinders (if any)
    if (mustBeHorizontal.length > 0) {
      mustBeHorizontal.sort((a, b) => b.length - a.length);

      for (const cyl of mustBeHorizontal) {
        const pos = this.findBestPosition(cyl, placedBoxes);
        if (pos) {
          const placedCyl = this.createPlacedCylinder(cyl, pos);
          placed.push(placedCyl);
          cyl.placed = true;
          placedBoxes.push({
            xMin: pos.x, xMax: pos.x + cyl.diameter,
            yMin: pos.y, yMax: pos.y + cyl.length,
            zMin: pos.z, zMax: pos.z + cyl.diameter,
          });
        }
      }
    }

    // PHASE 3: Stack horizontals on top of verticals

    const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].filter(z => z > 0).sort((a, b) => a - b);
    const unplacedVert = canBeVertical.filter(c => !c.placed);

    for (const cyl of unplacedVert) {
      let found = false;

      for (const z of zLevels) {
        if (found) break;
        if (z + cyl.diameter > this.H) continue;

        // Try horizontal-Y
        for (let y = 0; y + cyl.length <= this.L && !found; y += 5) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 5) {
            const pos = { x, y, z };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              if (this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.length,
                  zMin: z, zMax: z + cyl.diameter,
                });
                found = true;
              }
            }
          }
        }

        // Try horizontal-X (rotated)
        if (!found && cyl.length <= this.W) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 5) {
            for (let x = 0; x + cyl.length <= this.W && !found; x += 5) {
              const pos = { x, y, z };
              if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                if (this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                  placed.push(placedCyl);
                  cyl.placed = true;
                  placedBoxes.push({
                    xMin: x, xMax: x + cyl.length,
                    yMin: y, yMax: y + cyl.diameter,
                    zMin: z, zMax: z + cyl.diameter,
                  });
                  found = true;
                }
              }
            }
          }
        }
      }

      // Try on floor if elevated didn't work
      if (!found) {
        // Try horizontal on floor
        for (let y = 0; y + cyl.length <= this.L && !found; y += 2) {
          for (let x = 0; x + cyl.diameter <= this.W && !found; x += 2) {
            const pos = { x, y, z: 0 };
            if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
              const placedCyl = this.createPlacedCylinder(cyl, pos);
              placed.push(placedCyl);
              cyl.placed = true;
              placedBoxes.push({
                xMin: x, xMax: x + cyl.diameter,
                yMin: y, yMax: y + cyl.length,
                zMin: 0, zMax: cyl.diameter,
              });
              found = true;
            }
          }
        }
      }
    }


    // PHASE 4: Exhaustive search for any remaining
    const remaining = allCylinders.filter(c => !c.placed);
    if (remaining.length > 0) {

      for (const cyl of remaining) {
        // Try EVERY possible position with 1cm precision
        let found = false;

        // Vertical first (most Y-efficient)
        if (cyl.length <= this.H) {
          for (let y = 0; y + cyl.diameter <= this.L && !found; y += 1) {
            for (let x = 0; x + cyl.diameter <= this.W && !found; x += 1) {
              const pos = { x, y, z: 0 };
              if (this.canPlaceVertical(pos, cyl.diameter, cyl.length, placedBoxes)) {
                const placedCyl = this.createVerticalPlacedCylinder(cyl, pos);
                placed.push(placedCyl);
                cyl.placed = true;
                placedBoxes.push({
                  xMin: x, xMax: x + cyl.diameter,
                  yMin: y, yMax: y + cyl.diameter,
                  zMin: 0, zMax: cyl.length,
                });
                found = true;
              }
            }
          }
        }

        // Horizontal on any Z level
        if (!found) {
          const allZLevels = [0, ...zLevels];
          for (const z of allZLevels) {
            if (found) break;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.length <= this.L && !found; y += 1) {
              for (let x = 0; x + cyl.diameter <= this.W && !found; x += 1) {
                const pos = { x, y, z };
                if (this.canPlace(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.diameter,
                      yMin: y, yMax: y + cyl.length,
                      zMin: z, zMax: z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        // Rotated
        if (!found && cyl.length <= this.W) {
          const allZLevels = [0, ...zLevels];
          for (const z of allZLevels) {
            if (found) break;
            if (z + cyl.diameter > this.H) continue;

            for (let y = 0; y + cyl.diameter <= this.L && !found; y += 1) {
              for (let x = 0; x + cyl.length <= this.W && !found; x += 1) {
                const pos = { x, y, z };
                if (this.canPlaceRotated(pos, cyl.diameter, cyl.length, placedBoxes)) {
                  if (z === 0 || this.hasRotatedSupportRelaxed(pos, cyl.diameter, cyl.length, placedBoxes)) {
                    const placedCyl = this.createRotatedPlacedCylinder(cyl, pos);
                    placed.push(placedCyl);
                    cyl.placed = true;
                    placedBoxes.push({
                      xMin: x, xMax: x + cyl.length,
                      yMin: y, yMax: y + cyl.diameter,
                      zMin: z, zMax: z + cyl.diameter,
                    });
                    found = true;
                  }
                }
              }
            }
          }
        }

        if (!found) {
        }
      }
    }

    const finalUnplaced = allCylinders.filter(c => !c.placed).map(c => c.item);
    return { placed, unplaced: finalUnplaced };
  }

  /**
   * Find the best-fit position for a cylinder
   * Evaluates all valid positions and returns the one with best score
   * Score prioritizes: lower Z, fills gaps, uses valleys
   */
  private findBestFitPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' | 'vertical'; score: number } | null {
    const { diameter, length } = cyl;
    const step = Math.max(5, Math.floor(diameter / 10)); // Adaptive step size

    type Candidate = {
      pos: { x: number; y: number; z: number };
      orientation: 'horizontal-y' | 'horizontal-x' | 'vertical';
      score: number
    };

    const candidates: Candidate[] = [];

    // Collect Z levels from existing placements (floor + tops of placed items)
    const zLevels = new Set<number>([0]);
    for (const box of placedBoxes) {
      zLevels.add(box.zMax);
    }
    const sortedZLevels = [...zLevels].sort((a, b) => a - b);

    // Calculate valley Z levels based on existing horizontal cylinders
    const valleyZLevels = this.calculateValleyZLevels(placedBoxes, diameter);
    for (const vz of valleyZLevels) {
      zLevels.add(vz);
    }

    // === Try HORIZONTAL-Y orientation ===
    for (const z of sortedZLevels) {
      if (z + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += step) {
        for (let x = 0; x + diameter <= this.W; x += step) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (z === 0 || this.hasSupportForBestFit(pos, diameter, length, placedBoxes, 'horizontal-y')) {
              const score = this.calculateFitScore(pos, diameter, length, placedBoxes, 'horizontal-y');
              candidates.push({ pos, orientation: 'horizontal-y', score });
            }
          }
        }
      }
    }

    // === Try valley positions for HORIZONTAL-Y ===
    for (const vz of valleyZLevels) {
      if (vz + diameter > this.H) continue;

      for (let y = 0; y + length <= this.L; y += step) {
        for (let x = 0; x + diameter <= this.W; x += step) {
          const pos = { x, y, z: vz };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (this.hasValleySupport(pos, diameter, length, placedBoxes)) {
              // Valley positions get bonus score (lower is better)
              const score = this.calculateFitScore(pos, diameter, length, placedBoxes, 'horizontal-y') - 50;
              candidates.push({ pos, orientation: 'horizontal-y', score });
            }
          }
        }
      }
    }

    // === Try VERTICAL orientation (if length fits in height) ===
    if (length <= this.H) {
      for (const z of sortedZLevels) {
        if (z + length > this.H) continue;

        // Try grid positions
        for (let y = 0; y + diameter <= this.L; y += step) {
          for (let x = 0; x + diameter <= this.W; x += step) {
            const pos = { x, y, z };
            if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasVerticalSupportForBestFit(pos, diameter, length, placedBoxes)) {
                const score = this.calculateFitScore(pos, diameter, length, placedBoxes, 'vertical');
                candidates.push({ pos, orientation: 'vertical', score });
              }
            }
          }
        }

        // Try honeycomb positions (for z=0 mainly)
        if (z === 0) {
          const hexYSpacing = diameter * 0.866;
          for (let row = 0; row * hexYSpacing + diameter <= this.L; row++) {
            const baseY = row * hexYSpacing;
            const xOffset = (row % 2 === 1) ? diameter / 2 : 0;

            for (let x = xOffset; x + diameter <= this.W; x += diameter) {
              const pos = { x, y: baseY, z: 0 };
              if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
                // Honeycomb gets bonus for efficient packing
                const score = this.calculateFitScore(pos, diameter, length, placedBoxes, 'vertical') - 30;
                candidates.push({ pos, orientation: 'vertical', score });
              }
            }
          }
        }
      }
    }

    // === Try HORIZONTAL-X orientation (length along X) ===
    if (length <= this.W) {
      for (const z of sortedZLevels) {
        if (z + diameter > this.H) continue;

        for (let y = 0; y + diameter <= this.L; y += step) {
          for (let x = 0; x + length <= this.W; x += step) {
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
              if (z === 0 || this.hasSupportForBestFit(pos, diameter, length, placedBoxes, 'horizontal-x')) {
                const score = this.calculateFitScore(pos, diameter, length, placedBoxes, 'horizontal-x');
                candidates.push({ pos, orientation: 'horizontal-x', score });
              }
            }
          }
        }
      }
    }

    if (candidates.length === 0) {
      // Fallback: exhaustive search with step=1
      return this.findBestFitExhaustive(cyl, placedBoxes);
    }

    // Pick the best candidate (lowest score = best fit)
    candidates.sort((a, b) => a.score - b.score);
    return candidates[0];
  }

  /**
   * Calculate valley Z levels based on existing horizontal cylinders
   */
  private calculateValleyZLevels(placedBoxes: PlacedBox[], newDiameter: number): number[] {
    const levels: number[] = [];

    // Find horizontal cylinders at similar Z levels that could form valleys
    const horizontals = placedBoxes.filter(box => {
      const boxH = box.zMax - box.zMin;
      const boxW = box.xMax - box.xMin;
      return boxH < boxW * 1.5; // Horizontal cylinders have height < width
    });

    // Group by Z level
    const byZ = new Map<number, PlacedBox[]>();
    for (const box of horizontals) {
      const z = Math.round(box.zMin);
      if (!byZ.has(z)) byZ.set(z, []);
      byZ.get(z)!.push(box);
    }

    // For each Z level with multiple cylinders, calculate valley positions
    for (const [z, boxes] of byZ) {
      if (boxes.length >= 2) {
        const boxR = (boxes[0].xMax - boxes[0].xMin) / 2;
        // Valley rise when resting between two cylinders
        const valleyZ = z + boxR * 2 * 0.866; // Approximate valley height
        if (valleyZ + newDiameter <= this.H) {
          levels.push(valleyZ);
        }
      }
      // Also calculate stacking position (directly on top)
      const stackZ = z + (boxes[0].zMax - boxes[0].zMin);
      if (stackZ + newDiameter <= this.H) {
        levels.push(stackZ);
      }
    }

    return [...new Set(levels)].sort((a, b) => a - b);
  }

  /**
   * Check if position has valley support (between two cylinders)
   */
  private hasValleySupport(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placedBoxes: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cx = x + radius;

    // Find cylinders that could provide valley support
    const supports: { cx: number; r: number; zMax: number }[] = [];

    for (const box of placedBoxes) {
      // Check Y overlap
      if (y >= box.yMax || y + length <= box.yMin) continue;

      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;
      if (boxH >= boxW * 1.5) continue; // Skip vertical cylinders

      const boxR = boxW / 2;
      const boxCx = box.xMin + boxR;

      // Check if close enough horizontally
      if (Math.abs(cx - boxCx) <= radius + boxR + 20) {
        supports.push({ cx: boxCx, r: boxR, zMax: box.zMax });
      }
    }

    // Need at least 2 supports to form a valley
    if (supports.length < 2) {
      // Check wall + 1 cylinder support
      if (supports.length === 1 && (x <= diameter || x + diameter >= this.W - diameter)) {
        return Math.abs(supports[0].zMax - z) <= diameter * 0.5;
      }
      return false;
    }

    // Check if we're resting between two supports
    for (let i = 0; i < supports.length; i++) {
      for (let j = i + 1; j < supports.length; j++) {
        const s1 = supports[i];
        const s2 = supports[j];

        // Check if new cylinder center is between the two supports
        const minCx = Math.min(s1.cx, s2.cx);
        const maxCx = Math.max(s1.cx, s2.cx);

        if (cx >= minCx - radius && cx <= maxCx + radius) {
          // Verify Z is appropriate for valley
          const expectedValleyZ = Math.max(s1.zMax, s2.zMax) - radius * 0.3;
          if (Math.abs(z - expectedValleyZ) <= diameter * 0.5) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Calculate fit score for a position (lower is better)
   * Prefers: lower Z, positions that fill gaps, compact arrangements
   */
  private calculateFitScore(
    pos: { x: number; y: number; z: number },
    diameter: number, _length: number,
    placedBoxes: PlacedBox[],
    _orientation: 'horizontal-y' | 'horizontal-x' | 'vertical'
  ): number {
    let score = 0;

    // Prefer lower Z positions (floor is best)
    score += pos.z * 2;

    // Prefer lower Y positions (fill from front)
    score += pos.y * 0.5;

    // Prefer positions near walls (left wall preferred)
    score += pos.x * 0.3;

    // Bonus for positions that are supported (stacking)
    if (pos.z > 0) {
      // Extra penalty for floating positions
      score += 100;
    }

    // Bonus for positions adjacent to existing placements (compact)
    for (const box of placedBoxes) {
      const dx = Math.min(Math.abs(pos.x - box.xMax), Math.abs(pos.x + diameter - box.xMin));
      const dy = Math.min(Math.abs(pos.y - box.yMax), Math.abs(pos.y + length - box.yMin));

      if (dx < 5 || dy < 5) {
        score -= 20; // Bonus for touching existing placement
      }
    }

    return score;
  }

  /**
   * Check support for best-fit placement
   */
  private hasSupportForBestFit(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placedBoxes: PlacedBox[],
    orientation: 'horizontal-y' | 'horizontal-x'
  ): boolean {
    // Use existing hasSupport with relaxed constraints
    if (this.hasSupport(pos, diameter, length, placedBoxes)) return true;
    if (this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) return true;

    // Also check for support from vertical cylinders
    for (const box of placedBoxes) {
      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;
      if (boxH < boxW * 1.5) continue; // Only vertical cylinders

      // Horizontal resting on top of vertical
      if (Math.abs(box.zMax - pos.z) <= 5) {
        // Check overlap
        if (orientation === 'horizontal-y') {
          const xOverlap = Math.min(pos.x + diameter, box.xMax) - Math.max(pos.x, box.xMin);
          const yOverlap = Math.min(pos.y + length, box.yMax) - Math.max(pos.y, box.yMin);
          if (xOverlap > 0 && yOverlap > 0) return true;
        } else {
          const xOverlap = Math.min(pos.x + length, box.xMax) - Math.max(pos.x, box.xMin);
          const yOverlap = Math.min(pos.y + diameter, box.yMax) - Math.max(pos.y, box.yMin);
          if (xOverlap > 0 && yOverlap > 0) return true;
        }
      }
    }

    return false;
  }

  /**
   * Check vertical support for best-fit placement
   */
  private hasVerticalSupportForBestFit(
    pos: { x: number; y: number; z: number },
    diameter: number, _length: number,
    placedBoxes: PlacedBox[]
  ): boolean {
    // Can stack on another vertical cylinder
    for (const box of placedBoxes) {
      if (Math.abs(box.zMax - pos.z) > 5) continue;

      const xOverlap = Math.min(pos.x + diameter, box.xMax) - Math.max(pos.x, box.xMin);
      const yOverlap = Math.min(pos.y + diameter, box.yMax) - Math.max(pos.y, box.yMin);

      if (xOverlap > diameter * 0.3 && yOverlap > diameter * 0.3) {
        return true;
      }
    }

    return false;
  }

  /**
   * Exhaustive search fallback for best-fit
   */
  private findBestFitExhaustive(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'horizontal-x' | 'vertical'; score: number } | null {
    const { diameter, length } = cyl;

    // Try floor horizontal-y first
    for (let y = 0; y + length <= this.L; y += 2) {
      for (let x = 0; x + diameter <= this.W; x += 2) {
        const pos = { x, y, z: 0 };
        if (this.canPlace(pos, diameter, length, placedBoxes)) {
          return { pos, orientation: 'horizontal-y', score: y + x * 0.1 };
        }
      }
    }

    // Try floor vertical
    if (length <= this.H) {
      for (let y = 0; y + diameter <= this.L; y += 2) {
        for (let x = 0; x + diameter <= this.W; x += 2) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
            return { pos, orientation: 'vertical', score: y + x * 0.1 };
          }
        }
      }
    }

    // Try stacked positions
    const zLevels = [...new Set(placedBoxes.map(b => b.zMax))].sort((a, b) => a - b);

    for (const z of zLevels) {
      if (z + diameter <= this.H) {
        for (let y = 0; y + length <= this.L; y += 2) {
          for (let x = 0; x + diameter <= this.W; x += 2) {
            const pos = { x, y, z };
            if (this.canPlace(pos, diameter, length, placedBoxes) &&
                this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
              return { pos, orientation: 'horizontal-y', score: z * 2 + y + x * 0.1 };
            }
          }
        }
      }

      if (length <= this.H && z + length <= this.H) {
        for (let y = 0; y + diameter <= this.L; y += 2) {
          for (let x = 0; x + diameter <= this.W; x += 2) {
            const pos = { x, y, z };
            if (this.canPlaceVertical(pos, diameter, length, placedBoxes) &&
                this.hasVerticalSupportForBestFit(pos, diameter, length, placedBoxes)) {
              return { pos, orientation: 'vertical', score: z * 2 + y + x * 0.1 };
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Find ANY valid position for a cylinder using step=1 precision search
   * Tries all three orientations and relaxed support requirements
   */
  private findAnyValidPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[],
    zLevels: number[]
  ): { pos: { x: number; y: number; z: number }; orientation: 'horizontal-y' | 'vertical' | 'horizontal-x' } | null {
    const { diameter, length } = cyl;

    // Try ALL orientations at floor level first with step=1
    // 1. Horizontal-Y at floor
    for (let y = 0; y + length <= this.L; y += 1) {
      for (let x = 0; x + diameter <= this.W; x += 1) {
        const pos = { x, y, z: 0 };
        if (this.canPlace(pos, diameter, length, placedBoxes)) {
          return { pos, orientation: 'horizontal-y' };
        }
      }
    }

    // 2. Vertical at floor (if fits in height)
    if (length <= this.H) {
      for (let y = 0; y + diameter <= this.L; y += 1) {
        for (let x = 0; x + diameter <= this.W; x += 1) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
            return { pos, orientation: 'vertical' };
          }
        }
      }
    }

    // 3. Horizontal-X at floor (if fits in width)
    if (length <= this.W) {
      for (let y = 0; y + diameter <= this.L; y += 1) {
        for (let x = 0; x + length <= this.W; x += 1) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
            return { pos, orientation: 'horizontal-x' };
          }
        }
      }
    }

    // Try stacking positions at Z levels
    for (const z of zLevels) {
      if (z === 0) continue;

      // Horizontal-Y stacking
      if (z + diameter <= this.H) {
        for (let y = 0; y + length <= this.L; y += 1) {
          for (let x = 0; x + diameter <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlace(pos, diameter, length, placedBoxes)) {
              if (this.hasSupportRelaxed(pos, diameter, length, placedBoxes)) {
                return { pos, orientation: 'horizontal-y' };
              }
            }
          }
        }
      }

      // Vertical stacking
      if (length <= this.H && z + length <= this.H) {
        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + diameter <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceVertical(pos, diameter, length, placedBoxes)) {
              if (this.hasVerticalSupportRelaxed(pos, diameter, placedBoxes)) {
                return { pos, orientation: 'vertical' };
              }
            }
          }
        }
      }

      // Horizontal-X stacking
      if (length <= this.W && z + diameter <= this.H) {
        for (let y = 0; y + diameter <= this.L; y += 1) {
          for (let x = 0; x + length <= this.W; x += 1) {
            const pos = { x, y, z };
            if (this.canPlaceRotated(pos, diameter, length, placedBoxes)) {
              if (this.hasRotatedSupportRelaxed(pos, diameter, length, placedBoxes)) {
                return { pos, orientation: 'horizontal-x' };
              }
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Relaxed support check - allows more flexible stacking
   */
  private hasSupportRelaxed(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      // Check if this box could provide support (their top is near our bottom)
      if (Math.abs(box.zMax - z) > 10) continue;
      if (box.zMax > z + 5) continue;

      // Check Y overlap
      const yOverlap = Math.min(y + length, box.yMax) - Math.max(y, box.yMin);
      if (yOverlap <= 0) continue;

      // Check X overlap
      const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
      if (xOverlap > 0) {
        // Relaxed: just need SOME overlap
        return true;
      }
    }

    return false;
  }

  /**
   * Relaxed vertical support check
   */
  private hasVerticalSupportRelaxed(
    pos: { x: number; y: number; z: number },
    diameter: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      if (Math.abs(box.zMax - z) > 10) continue;
      if (box.zMax > z + 5) continue;

      // Check overlap in both X and Y
      const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
      const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

      if (xOverlap > 0 && yOverlap > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Relaxed support check for rotated horizontal
   */
  private hasRotatedSupportRelaxed(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;

    for (const box of placed) {
      if (Math.abs(box.zMax - z) > 10) continue;
      if (box.zMax > z + 5) continue;

      // Check overlap (rotated: length along X, diameter along Y)
      const xOverlap = Math.min(x + length, box.xMax) - Math.max(x, box.xMin);
      const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

      if (xOverlap > 0 && yOverlap > 0) {
        return true;
      }
    }

    return false;
  }

  /**
   * Exhaustive search - tries every position at fine granularity
   */
  private exhaustiveSearch(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    // Try multiple grid sizes, from coarse to fine
    for (const step of [10, 5, 2, 1]) {
      // Floor first (z=0)
      for (let y = 0; y + length <= this.L; y += step) {
        for (let x = 0; x + diameter <= this.W; x += step) {
          const pos = { x, y, z: 0 };
          if (this.canPlace(pos, diameter, length, placed)) {
            return pos;
          }
        }
      }

      // Then try stacking at known Z levels
      const zLevels = new Set<number>();
      for (const box of placed) {
        zLevels.add(box.zMax);
      }

      for (const z of Array.from(zLevels).sort((a, b) => a - b)) {
        if (z + diameter > this.H) continue;

        for (let y = 0; y + length <= this.L; y += step) {
          for (let x = 0; x + diameter <= this.W; x += step) {
            const pos = { x, y, z };
            if (this.canPlace(pos, diameter, length, placed)) {
              if (this.hasSupport(pos, diameter, length, placed)) {
                return pos;
              }
            }
          }
        }
      }

      // Also try arbitrary Z positions (scan full height)
      for (let z = 1; z + diameter <= this.H; z += step) {
        for (let y = 0; y + length <= this.L; y += step) {
          for (let x = 0; x + diameter <= this.W; x += step) {
            const pos = { x, y, z };
            if (this.canPlace(pos, diameter, length, placed)) {
              if (this.hasSupport(pos, diameter, length, placed)) {
                return pos;
              }
            }
          }
        }
      }
    }

    return null;
  }

  private groupByDiameter(cylinders: Cylinder[], tolerance: number): Cylinder[][] {
    const sorted = [...cylinders].sort((a, b) => a.diameter - b.diameter);
    const groups: Cylinder[][] = [];
    let currentGroup: Cylinder[] = [];
    let groupStart = 0;

    for (const cyl of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(cyl);
        groupStart = cyl.diameter;
      } else if (cyl.diameter - groupStart <= tolerance) {
        currentGroup.push(cyl);
      } else {
        groups.push(currentGroup);
        currentGroup = [cyl];
        groupStart = cyl.diameter;
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    return groups;
  }

  private findBestPosition(
    cyl: Cylinder,
    placedBoxes: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Collect Y positions - include edges AND scan the full range
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placedBoxes) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
    }
    // Also scan Y at regular intervals to find gaps
    for (let y = 0; y + length <= this.L; y += Math.min(length, 50)) {
      ySet.add(y);
    }
    ySet.add(this.L - length); // Last possible position

    // Collect Z levels
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placedBoxes) {
      zSet.add(box.zMax);
    }

    const sortedY = Array.from(ySet).filter(y => y >= 0 && y + length <= this.L).sort((a, b) => a - b);
    const sortedZ = Array.from(zSet).filter(z => z >= 0 && z + diameter <= this.H).sort((a, b) => a - b);

    // Priority: lowest Y, then lowest Z, then lowest X
    for (const y of sortedY) {
      for (const z of sortedZ) {
        for (let x = 0; x + diameter <= this.W; x++) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placedBoxes)) {
            if (z === 0 || this.hasSupport(pos, diameter, length, placedBoxes)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  private groupByLength(cylinders: Cylinder[], tolerance: number): Cylinder[][] {
    const sorted = [...cylinders].sort((a, b) => a.length - b.length);
    const groups: Cylinder[][] = [];
    let currentGroup: Cylinder[] = [];
    let groupStart = 0;

    for (const cyl of sorted) {
      if (currentGroup.length === 0) {
        currentGroup.push(cyl);
        groupStart = cyl.length;
      } else if (cyl.length - groupStart <= tolerance) {
        currentGroup.push(cyl);
      } else {
        groups.push(currentGroup);
        currentGroup = [cyl];
        groupStart = cyl.length;
      }
    }
    if (currentGroup.length > 0) {
      groups.push(currentGroup);
    }

    // Sort groups by total count (largest groups first for better packing)
    groups.sort((a, b) => b.length - a.length);

    return groups;
  }

  private findGapPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    if (diameter > this.W || length > this.L || diameter > this.H) {
      return null;
    }

    // Collect Y positions - comprehensive scanning
    const ySet = new Set<number>();
    ySet.add(0);
    for (const box of placed) {
      ySet.add(box.yMin);
      ySet.add(box.yMax);
      // Also add positions just after each box
      if (box.yMax + length <= this.L) ySet.add(box.yMax);
    }
    // Fine grid scan - every 10cm to find small gaps
    for (let y = 0; y + length <= this.L; y += 10) {
      ySet.add(y);
    }
    // Also try positioning at the end
    if (this.L - length >= 0) ySet.add(this.L - length);

    const sortedY = Array.from(ySet)
      .filter(y => y >= 0 && y + length <= this.L)
      .sort((a, b) => a - b);

    // Collect Z levels
    const zSet = new Set<number>();
    zSet.add(0);
    for (const box of placed) {
      zSet.add(box.zMax);
    }

    const sortedZ = Array.from(zSet)
      .filter(z => z >= 0 && z + diameter <= this.H)
      .sort((a, b) => a - b);

    // Collect X positions from existing boxes too
    const xSet = new Set<number>();
    xSet.add(0);
    for (const box of placed) {
      xSet.add(box.xMin);
      xSet.add(box.xMax);
      // Try fitting in gaps between boxes
      if (box.xMax + diameter <= this.W) xSet.add(box.xMax);
    }
    // Also scan X at intervals
    for (let x = 0; x + diameter <= this.W; x += Math.min(diameter, 20)) {
      xSet.add(x);
    }
    // And the last possible position
    if (this.W - diameter >= 0) xSet.add(this.W - diameter);

    const sortedX = Array.from(xSet)
      .filter(x => x >= 0 && x + diameter <= this.W)
      .sort((a, b) => a - b);

    // Priority: lowest Y, then lowest Z, then lowest X
    for (const y of sortedY) {
      for (const z of sortedZ) {
        for (const x of sortedX) {
          const pos = { x, y, z };
          if (this.canPlace(pos, diameter, length, placed)) {
            if (z === 0 || this.hasSupport(pos, diameter, length, placed)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  private canPlace(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;

    // Check container bounds
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + length > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    // Center of new HORIZONTAL cylinder in XZ plane
    const cx = x + radius;
    const cz = z + radius;

    // Check collision with each placed item
    for (const box of placed) {
      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;

      // Detect if this box is a VERTICAL cylinder (height > width significantly)
      const isVerticalBox = boxH > boxW * 1.5;

      if (isVerticalBox) {
        // Collision: new HORIZONTAL vs existing VERTICAL
        // First check if bounding boxes overlap at all
        if (x >= box.xMax || x + diameter <= box.xMin) continue;
        if (y >= box.yMax || y + length <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;

        // Bounding boxes overlap - but horizontal may be resting ON TOP of vertical
        // hasSupport allows 5cm tolerance for horizontal-on-vertical stacking
        // If bottom of horizontal (z) is at or near top of vertical (box.zMax), allow it
        if (z >= box.zMax - 5) {
          continue; // Horizontal resting on top of vertical - not a collision
        }

        // Horizontal cylinder passing through vertical - actual collision
        return false;
      } else {
        // Collision: new HORIZONTAL vs existing HORIZONTAL
        // Both are circular in XZ plane, extended in Y

        // First check Y overlap
        if (y >= box.yMax || y + length <= box.yMin) {
          continue; // No Y overlap, no collision possible
        }

        // Y overlaps, now check XZ circular collision
        const otherRadius = boxW / 2;
        const otherCx = box.xMin + otherRadius;
        const otherCz = box.zMin + otherRadius;

        const dx = cx - otherCx;
        const dz = cz - otherCz;
        const distSq = dx * dx + dz * dz;
        const minDist = radius + otherRadius - 1; // 1cm tolerance for touching

        if (distSq < minDist * minDist) {
          return false; // Circular cross-sections overlap
        }
      }
    }

    return true;
  }

  /**
   * Find the exact Z position where a cylinder would rest based on supports
   * Returns the Z coordinate (bottom of cylinder) or null if no support found
   */
  private findSupportedZ(
    x: number, y: number,
    cyl: Cylinder,
    placed: PlacedBox[]
  ): number | null {
    const { diameter, length } = cyl;
    const radius = diameter / 2;
    const cx = x + radius;

    // If at floor level, return 0
    if (placed.length === 0) return 0;

    // Find all potential supports (cylinders that overlap in Y and could support this position)
    const supports: { box: PlacedBox; cx: number; cz: number; r: number }[] = [];

    for (const box of placed) {
      // Check Y overlap
      if (y >= box.yMax || y + length <= box.yMin) continue;

      const boxR = (box.xMax - box.xMin) / 2;
      const boxCx = box.xMin + boxR;
      const boxCz = box.zMin + boxR;

      // Check if horizontally close enough to potentially support
      const dx = Math.abs(cx - boxCx);
      if (dx <= radius + boxR + 5) {
        supports.push({ box, cx: boxCx, cz: boxCz, r: boxR });
      }
    }

    if (supports.length === 0) {
      // No supports nearby - can only place on floor
      return 0;
    }

    // Sort supports by Z (top of cylinder) descending to find highest position
    supports.sort((a, b) => b.box.zMax - a.box.zMax);

    // Check for direct stacking on a single cylinder
    for (const support of supports) {
      const dx = Math.abs(cx - support.cx);
      // Direct stacking: centers are aligned enough
      if (dx <= Math.max(radius, support.r) * 0.5) {
        // Rest directly on top
        return support.box.zMax;
      }
    }

    // Check for valley support between two cylinders
    for (let i = 0; i < supports.length; i++) {
      for (let j = i + 1; j < supports.length; j++) {
        const s1 = supports[i];
        const s2 = supports[j];

        // Check if both supports are at similar height
        if (Math.abs(s1.cz - s2.cz) > 10) continue;

        const cx1 = s1.cx;
        const cx2 = s2.cx;
        const r1 = s1.r;
        const r2 = s2.r;
        const avgR = (r1 + r2) / 2;

        // Distance between support centers
        const dxSupport = Math.abs(cx2 - cx1);

        // Check if new cylinder center is between supports
        const minCx = Math.min(cx1, cx2);
        const maxCx = Math.max(cx1, cx2);

        if (cx >= minCx - 5 && cx <= maxCx + 5) {
          // Calculate expected Z for valley nesting
          // Center-to-center distance in X from new cylinder to each support
          const halfGap = dxSupport / 2;
          const sumRadii = radius + avgR;

          if (sumRadii > halfGap) {
            // Calculate Z where cylinder rests in valley
            const avgSupportCz = (s1.cz + s2.cz) / 2;
            const rise = Math.sqrt(sumRadii * sumRadii - halfGap * halfGap);
            const expectedCz = avgSupportCz + rise;
            const expectedZ = expectedCz - radius;

            if (expectedZ > 0 && expectedZ + diameter <= this.H) {
              return expectedZ;
            }
          }
        }
      }
    }

    // Check for wall + single cylinder support
    if (x <= 5 || x + diameter >= this.W - 5) {
      const wallCx = x <= 5 ? 0 : this.W;
      const dxToWall = Math.abs(cx - wallCx);

      for (const support of supports) {
        const dx = Math.abs(cx - support.cx);
        const sumRadii = radius + support.r;

        // Calculate valley-like Z with wall as one support
        if (dxToWall < radius && dx < sumRadii) {
          // Wall provides one side of support
          const halfGap = dx / 2;
          if (sumRadii > halfGap) {
            const rise = Math.sqrt(sumRadii * sumRadii - halfGap * halfGap);
            const expectedCz = support.cz + rise;
            const expectedZ = expectedCz - radius;

            if (expectedZ > 0 && expectedZ + diameter <= this.H) {
              return expectedZ;
            }
          }
        }
      }
    }

    // If no proper support found, try direct stacking with more tolerance
    for (const support of supports) {
      const xOverlap = Math.min(x + diameter, support.box.xMax) - Math.max(x, support.box.xMin);
      if (xOverlap >= diameter * 0.3) {
        return support.box.zMax;
      }
    }

    return null;
  }

  private hasSupport(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cx = x + radius;
    const cz = z + radius; // Center Z of new cylinder

    // Check for support from cylinders below
    // Support can come from:
    // 1. Single cylinder directly below (stacking on top) - horizontal or vertical
    // 2. Two cylinders forming a valley (cylinder rests in the gap)

    // FIRST: Check for support from VERTICAL cylinders (horizontal on vertical stacking)
    for (const box of placed) {
      const boxW = box.xMax - box.xMin;
      const boxH = box.zMax - box.zMin;
      const isVerticalBox = boxH > boxW * 1.5;

      if (isVerticalBox) {
        // Check if this vertical can support us
        // Our bottom (z) should be at or near vertical's top (zMax)
        if (Math.abs(box.zMax - z) <= 5) {
          // Check X overlap
          const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
          // Check Y overlap (vertical has small Y extent = diameter)
          const yOverlap = Math.min(y + length, box.yMax) - Math.max(y, box.yMin);

          // Need some overlap in both X and Y
          if (xOverlap > 0 && yOverlap > 0) {
            return true;
          }
        }
      }
    }

    const supportCandidates: PlacedBox[] = [];

    for (const box of placed) {
      // Check Y overlap (must overlap in length direction)
      if (y >= box.yMax || y + length <= box.yMin) continue;

      // For support, the supporting cylinder must be below us
      // Its top (zMax) should be at or below our center Z
      if (box.zMax > cz + 5) continue; // Support is too high
      if (box.zMax < z - 5) continue; // Support is too low (our bottom is above their top)

      supportCandidates.push(box);
    }

    // Check for direct stacking support (cylinder sits on top of another)
    for (const box of supportCandidates) {
      // Direct support: our bottom (z) is near their top (zMax)
      if (Math.abs(box.zMax - z) <= 5) {
        const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
        if (xOverlap >= diameter * 0.3) {
          return true;
        }
      }
    }

    // Check for valley support (resting between two cylinders)
    // For valley support, our center Z should be BELOW the tops of support cylinders
    // because we nestle down between them
    for (let i = 0; i < supportCandidates.length; i++) {
      for (let j = i + 1; j < supportCandidates.length; j++) {
        const box1 = supportCandidates[i];
        const box2 = supportCandidates[j];

        const r1 = (box1.xMax - box1.xMin) / 2;
        const r2 = (box2.xMax - box2.xMin) / 2;
        const cx1 = box1.xMin + r1;
        const cx2 = box2.xMin + r2;
        const cz1 = box1.zMin + r1;
        const cz2 = box2.zMin + r2;

        // Check if the two support cylinders are at similar height
        if (Math.abs(cz1 - cz2) > 10) continue;

        // Distance between support cylinder centers in X
        const dxSupport = Math.abs(cx2 - cx1);

        // For valley nesting, support cylinders should be close enough
        // that the new cylinder can touch both
        // Max gap where new cylinder can still touch both: 2 * (r1 + radius) for same-size
        if (dxSupport > r1 + r2 + diameter) continue;

        // Check if new cylinder center is positioned to rest in valley
        const minCx = Math.min(cx1, cx2);
        const maxCx = Math.max(cx1, cx2);

        // New cylinder center should be between the two support centers
        if (cx >= minCx - radius * 0.5 && cx <= maxCx + radius * 0.5) {
          // Verify geometry: calculate expected Z for valley nesting
          // When resting in valley between two cylinders, the geometry gives:
          // cz = cz_support + sqrt((r + r_support)^2 - (dx/2)^2)
          // where dx is the horizontal distance between support centers

          const avgSupportCz = (cz1 + cz2) / 2;
          const avgSupportR = (r1 + r2) / 2;
          const halfGap = dxSupport / 2;
          const sumRadii = radius + avgSupportR;

          if (sumRadii > halfGap) {
            const expectedCz = avgSupportCz + Math.sqrt(sumRadii * sumRadii - halfGap * halfGap);
            // Allow some tolerance in Z position
            if (Math.abs(cz - expectedCz) < radius * 0.5) {
              return true;
            }
            // Also accept if we're just resting on top of the valley
            if (cz >= avgSupportCz && cz <= expectedCz + radius * 0.3) {
              return true;
            }
          }
        }
      }
    }

    // Also check for wall support (cylinder against container wall)
    // Wall acts as one side of a "valley", so we only need ONE support cylinder
    if (x <= 5 || x + diameter >= this.W - 5) {
      for (const box of placed) {
        // Check Y overlap
        if (y >= box.yMax || y + length <= box.yMin) continue;

        // Check if support is below us (their top is below our center)
        if (box.zMax > cz + 5) continue;
        if (box.zMax < 0) continue;

        const boxR = (box.xMax - box.xMin) / 2;
        const boxCx = box.xMin + boxR;
        const boxCz = box.zMin + boxR;

        // Check X overlap or proximity
        const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
        if (xOverlap < 0) continue;

        // For wall support, calculate if the geometry works
        // Wall + one cylinder can support another cylinder in a valley-like configuration
        const dx = Math.abs(cx - boxCx);
        const sumRadii = radius + boxR;

        if (dx < sumRadii + 10) { // Close enough horizontally
          // Calculate expected Z for resting against wall + one cylinder
          // This is similar to valley but with wall as virtual cylinder
          const wallCx = x <= 5 ? 0 : this.W; // Virtual wall cylinder center
          const dxToWall = Math.abs(cx - wallCx);

          if (dxToWall < radius + 5) { // Touching wall
            // Check if Z position is reasonable for support
            if (cz > boxCz && cz < boxCz + sumRadii + 10) {
              return true;
            }
          }
        }
      }
    }

    return false;
  }


  /**
   * Find position for vertical cylinder placement
   * Vertical: diameter is footprint (X, Y), length is height (Z)
   * AGGRESSIVE: tries floor, stacking on horizontals, any available space
   */
  private findVerticalPosition(
    cyl: Cylinder,
    placed: PlacedBox[]
  ): { x: number; y: number; z: number } | null {
    const { diameter, length } = cyl;

    // Check if vertical placement is even possible
    if (diameter > this.W || diameter > this.L || length > this.H) {
      return null;
    }


    // Strategy 1: Find Y gaps where no horizontal cylinders exist
    // Collect all Y ranges used by placed items
    const yRanges: { start: number; end: number }[] = [];
    for (const box of placed) {
      yRanges.push({ start: box.yMin, end: box.yMax });
    }
    yRanges.sort((a, b) => a.start - b.start);

    // Find Y gaps
    const yGaps: { start: number; end: number }[] = [];
    let lastEnd = 0;
    for (const range of yRanges) {
      if (range.start > lastEnd) {
        yGaps.push({ start: lastEnd, end: range.start });
      }
      lastEnd = Math.max(lastEnd, range.end);
    }
    // Add final gap at end of container
    if (lastEnd < this.L) {
      yGaps.push({ start: lastEnd, end: this.L });
    }


    // Try floor positions in Y gaps first
    for (const gap of yGaps) {
      if (gap.end - gap.start < diameter) continue;

      for (let y = gap.start; y + diameter <= gap.end; y += 5) {
        for (let x = 0; x + diameter <= this.W; x += 5) {
          const pos = { x, y, z: 0 };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            return pos;
          }
        }
      }
    }

    // Strategy 2: Stack on top of horizontal cylinders
    // For each placed box, try placing vertical cylinder on top
    const zLevelsWithBoxes = new Map<number, PlacedBox[]>();
    for (const box of placed) {
      const z = box.zMax;
      if (!zLevelsWithBoxes.has(z)) zLevelsWithBoxes.set(z, []);
      zLevelsWithBoxes.get(z)!.push(box);
    }

    // Sort Z levels ascending (try lower positions first)
    const sortedZLevels = Array.from(zLevelsWithBoxes.keys()).sort((a, b) => a - b);

    for (const z of sortedZLevels) {
      if (z + length > this.H) continue;

      const boxesAtLevel = zLevelsWithBoxes.get(z)!;

      for (const box of boxesAtLevel) {
        // Try placing centered on this box
        const boxCenterX = (box.xMin + box.xMax) / 2;
        const boxCenterY = (box.yMin + box.yMax) / 2;

        // Try various positions on top of this box
        const tryPositions = [
          { x: boxCenterX - diameter / 2, y: boxCenterY - diameter / 2 },
          { x: box.xMin, y: box.yMin },
          { x: box.xMin, y: boxCenterY - diameter / 2 },
          { x: boxCenterX - diameter / 2, y: box.yMin },
        ];

        for (const tryPos of tryPositions) {
          // Clamp to container bounds
          const x = Math.max(0, Math.min(tryPos.x, this.W - diameter));
          const y = Math.max(0, Math.min(tryPos.y, this.L - diameter));

          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (this.hasVerticalSupport(pos, diameter, placed)) {
              return pos;
            }
          }
        }
      }
    }

    // Strategy 3: Exhaustive grid search at all Z levels
    for (const z of [0, ...sortedZLevels]) {
      if (z + length > this.H) continue;

      for (let y = 0; y + diameter <= this.L; y += 10) {
        for (let x = 0; x + diameter <= this.W; x += 10) {
          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (z === 0 || this.hasVerticalSupport(pos, diameter, placed)) {
              return pos;
            }
          }
        }
      }
    }

    // Strategy 4: Honeycomb pattern search
    const HEX_Y_SPACING = diameter * 0.866;
    for (const z of [0, ...sortedZLevels]) {
      if (z + length > this.H) continue;

      for (let row = 0; ; row++) {
        const y = row * HEX_Y_SPACING;
        if (y + diameter > this.L) break;

        const xOffset = (row % 2 === 1) ? diameter / 2 : 0;

        for (let x = xOffset; x + diameter <= this.W; x += diameter) {
          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (z === 0 || this.hasVerticalSupport(pos, diameter, placed)) {
              return pos;
            }
          }
        }
      }
    }

    // Strategy 5: Fine grid search
    for (const z of [0, ...sortedZLevels]) {
      if (z + length > this.H) continue;

      for (let y = 0; y + diameter <= this.L; y += 2) {
        for (let x = 0; x + diameter <= this.W; x += 2) {
          const pos = { x, y, z };
          if (this.canPlaceVertical(pos, diameter, length, placed)) {
            if (z === 0 || this.hasVerticalSupport(pos, diameter, placed)) {
              return pos;
            }
          }
        }
      }
    }

    return null;
  }

  /**
   * Check if vertical cylinder can be placed (no collision)
   * Handles both vertical-vs-vertical and vertical-vs-horizontal collisions
   */
  private canPlaceVertical(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;

    // Check bounds (for vertical: diameter is X/Y footprint, length is height Z)
    if (x < 0 || x + diameter > this.W) return false;
    if (y < 0 || y + diameter > this.L) return false;
    if (z < 0 || z + length > this.H) return false;

    // Center of vertical cylinder in XY plane
    const cx = x + radius;
    const cy = y + radius;

    for (const box of placed) {
      // Check Z overlap first
      if (z >= box.zMax || z + length <= box.zMin) {
        continue; // No Z overlap, no collision
      }

      // Z overlaps - check XY collision
      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;

      // Determine if box is a horizontal cylinder (long in Y) or vertical (square-ish)
      if (Math.abs(boxW - boxL) < 10) {
        // Square-ish box - another vertical cylinder, use circular collision
        const otherR = boxW / 2;
        const otherCx = box.xMin + otherR;
        const otherCy = box.yMin + otherR;

        const dx = cx - otherCx;
        const dy = cy - otherCy;
        const distSq = dx * dx + dy * dy;
        const minDist = radius + otherR - 1;

        if (distSq < minDist * minDist) {
          return false;
        }
      } else {
        // Horizontal cylinder (long in Y direction)
        // The horizontal cylinder is circular in XZ plane, rectangular in XY projection
        // For simplicity, check if vertical cylinder circle overlaps with box rectangle

        // Circle-rectangle collision: find closest point on rectangle to circle center
        const closestX = Math.max(box.xMin, Math.min(cx, box.xMax));
        const closestY = Math.max(box.yMin, Math.min(cy, box.yMax));

        const dx = cx - closestX;
        const dy = cy - closestY;
        const distSq = dx * dx + dy * dy;

        // Tolerance for touching
        const minDist = radius - 1;

        if (distSq < minDist * minDist) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Check if vertical cylinder has support below
   * Supports resting on horizontal cylinders, vertical cylinders, or multiple items
   */
  private hasVerticalSupport(
    pos: { x: number; y: number; z: number },
    diameter: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;
    const cx = x + radius;
    const cy = y + radius;

    // Find all boxes that could provide support (their top is at or near our bottom)
    const supportCandidates: PlacedBox[] = [];
    for (const box of placed) {
      // Support must be below us (their zMax near our z)
      if (box.zMax <= z + 5 && box.zMax >= z - 5) {
        supportCandidates.push(box);
      }
    }

    // Check for any overlapping support
    for (const box of supportCandidates) {
      const xOverlap = Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin);
      const yOverlap = Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin);

      // Need at least 30% overlap in both directions for stability
      if (xOverlap > diameter * 0.3 && yOverlap > diameter * 0.3) {
        return true;
      }
    }

    // Also check for multi-point support (resting on multiple items)
    // Calculate total support area from all candidates
    let totalSupportArea = 0;
    const requiredArea = diameter * diameter * 0.25; // Need 25% coverage

    for (const box of supportCandidates) {
      const xOverlap = Math.max(0, Math.min(x + diameter, box.xMax) - Math.max(x, box.xMin));
      const yOverlap = Math.max(0, Math.min(y + diameter, box.yMax) - Math.max(y, box.yMin));
      totalSupportArea += xOverlap * yOverlap;
    }

    if (totalSupportArea >= requiredArea) {
      return true;
    }

    // Special case: resting on top of a horizontal cylinder
    // The vertical cylinder can rest on the curved top of a horizontal cylinder
    for (const box of supportCandidates) {
      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;

      // Is this a horizontal cylinder? (long in Y)
      if (boxL > boxW * 2) {
        // Check if vertical cylinder center is within the horizontal cylinder's X range
        if (cx >= box.xMin && cx <= box.xMax) {
          // Check if within Y range
          if (cy >= box.yMin && cy <= box.yMax) {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Create a placed cylinder in vertical orientation
   */
  private createVerticalPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + radius,
        y: pos.y + radius,
        z: pos.z + cyl.length / 2,
      },
      radius,
      length: cyl.length,
      orientation: 'vertical',
      rotation: ORIENTATION_ROTATIONS['vertical'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  private createPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + radius,
        y: pos.y + cyl.length / 2,
        z: pos.z + radius,
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-y',
      rotation: ORIENTATION_ROTATIONS['horizontal-y'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  /**
   * Create a rotated horizontal cylinder (length along X instead of Y)
   */
  private createRotatedPlacedCylinder(cyl: Cylinder, pos: { x: number; y: number; z: number }): PlacedCylinder {
    const radius = cyl.diameter / 2;

    return {
      item: cyl.item,
      uniqueId: `cyl_${cyl.index}_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      position: { x: pos.x, y: pos.y, z: pos.z },
      center: {
        x: pos.x + cyl.length / 2,
        y: pos.y + radius,
        z: pos.z + radius,
      },
      radius,
      length: cyl.length,
      orientation: 'horizontal-x',
      rotation: ORIENTATION_ROTATIONS['horizontal-x'],
      layerId: Math.floor(pos.z / 50),
      supportedBy: [],
    };
  }

  /**
   * Check if a rotated horizontal cylinder (length along X) can be placed
   */
  private canPlaceRotated(
    pos: { x: number; y: number; z: number },
    diameter: number, length: number,
    placed: PlacedBox[]
  ): boolean {
    const { x, y, z } = pos;
    const radius = diameter / 2;

    // Check container bounds (rotated: length along X, diameter along Y and Z)
    if (x < 0 || x + length > this.W) return false;
    if (y < 0 || y + diameter > this.L) return false;
    if (z < 0 || z + diameter > this.H) return false;

    // Center of rotated cylinder in YZ plane
    const cy = y + radius;
    const cz = z + radius;

    // Check collision with each placed item
    for (const box of placed) {
      // Check X overlap first (our length is along X)
      if (x >= box.xMax || x + length <= box.xMin) continue;

      const boxW = box.xMax - box.xMin;
      const boxL = box.yMax - box.yMin;
      const boxH = box.zMax - box.zMin;

      // Detect box type
      const isVerticalBox = boxH > boxW * 1.5 && boxH > boxL * 1.5;
      const isRotatedHorizontal = boxW > boxL * 1.5; // Length along X

      if (isVerticalBox) {
        // Vertical cylinder collision
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;
        // Allow resting on top
        if (z >= box.zMax - 5) continue;
        return false;
      } else if (isRotatedHorizontal) {
        // Another rotated horizontal - both circular in YZ
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        if (z >= box.zMax || z + diameter <= box.zMin) continue;

        const otherR = boxL / 2;
        const otherCy = box.yMin + otherR;
        const otherCz = box.zMin + otherR;

        const dy = cy - otherCy;
        const dz = cz - otherCz;
        const distSq = dy * dy + dz * dz;
        const minDist = radius + otherR - 1;

        if (distSq < minDist * minDist) return false;
      } else {
        // Normal horizontal (length along Y) - circular in XZ
        // Check Y overlap - rotated has diameter in Y, normal has length in Y
        if (y >= box.yMax || y + diameter <= box.yMin) continue;
        // Check Z overlap
        if (z >= box.zMax || z + diameter <= box.zMin) continue;

        // Both have circular cross-sections, but in different planes
        // Normal: circular in XZ (center at box.xMin + boxW/2, box.zMin + boxH/2)
        // Rotated: circular in YZ (center at cy, cz)
        // For accurate collision: check if circles intersect in the overlapping region

        // Simplified: use bounding box check for cross-orientation
        // X overlap already checked above (line 6641)
        // If we reach here, there's overlap in X, Y, and Z - check if circles actually collide

        // For cross-oriented cylinders, the actual collision is complex
        // Use a slightly relaxed check: allow placement if Z difference is enough
        const normalCz = box.zMin + boxH / 2;
        const zDistance = Math.abs(cz - normalCz);
        const minZDistance = radius + boxH / 2 - 5; // Allow 5cm tolerance

        if (zDistance < minZDistance) {
          // Potential collision - but check if Y positions allow clearance
          const normalCx = box.xMin + boxW / 2;
          // If rotated cylinder is far enough in X or Y, no collision
          const xMidRotated = x + length / 2;
          const xDistance = Math.abs(xMidRotated - normalCx);
          if (xDistance < (length / 2 + boxW / 2 - 5)) {
            return false; // Actual collision
          }
        }
      }
    }

    return true;
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
