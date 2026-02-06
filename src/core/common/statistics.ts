// src/core/common/statistics.ts

import type { Container, CargoItem, PlacedItem, LoadingStats, UnplacedSummary } from './types';

/**
 * Calculate the volume of a single placed item in cm3.
 */
function itemVolume(item: PlacedItem): number {
  if (item.type === 'cylinder') {
    const r = item.dimensions.width / 2;
    return Math.PI * r * r * item.dimensions.height;
  }
  return item.dimensions.width * item.dimensions.length * item.dimensions.height;
}

/**
 * Calculate loading statistics from placed results.
 */
export function calculateStats(
  container: Container,
  cargoList: CargoItem[],
  placedItems: PlacedItem[]
): { stats: LoadingStats; unplacedSummary: UnplacedSummary[] } {
  const contVol =
    (container.dimensions.width *
      container.dimensions.length *
      container.dimensions.height) /
    1_000_000; // cm3 -> m3

  let usedVol = 0;
  for (const item of placedItems) {
    usedVol += itemVolume(item);
  }
  usedVol = usedVol / 1_000_000; // cm3 -> m3

  const rate = contVol > 0 ? (usedVol / contVol) * 100 : 0;
  const totalQty = cargoList.reduce((acc, item) => acc + item.quantity, 0);
  const unplacedCount = totalQty - placedItems.length;

  // Group unplaced items
  const placedByName = new Map<string, number>();
  for (const item of placedItems) {
    placedByName.set(item.name, (placedByName.get(item.name) || 0) + 1);
  }

  const unplacedMap = new Map<string, number>();
  for (const cargo of cargoList) {
    const placedOfThis = placedByName.get(cargo.name) || 0;
    const unplacedOfThis = cargo.quantity - placedOfThis;
    if (unplacedOfThis > 0) {
      unplacedMap.set(cargo.name, unplacedOfThis);
    }
    if (placedOfThis > 0) {
      placedByName.set(cargo.name, Math.max(0, placedOfThis - cargo.quantity));
    }
  }

  const unplacedSummary = Array.from(unplacedMap.entries()).map(
    ([name, count]) => ({ name, count })
  );

  return {
    stats: {
      totalVolume: Number(contVol.toFixed(2)),
      usedVolume: Number(usedVol.toFixed(2)),
      fillRate: Number(rate.toFixed(2)),
      placedCount: placedItems.length,
      totalCount: totalQty,
      unplacedCount,
    },
    unplacedSummary,
  };
}

/**
 * Empty/initial loading stats.
 */
export const EMPTY_STATS: LoadingStats = {
  totalVolume: 0,
  usedVolume: 0,
  fillRate: 0,
  placedCount: 0,
  totalCount: 0,
  unplacedCount: 0,
};
