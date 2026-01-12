
import { OptimizedCoilSolver } from './src/core/solvers/coil-solver/optimized-solver';
import { Container, CargoItem } from './src/common/types';

// Mock types if needed, but we import from source
// We need to mock the Container object
const container: Container = {
  id: '40hc',
  name: '40HC Container',
  dimensions: {
    width: 235,
    length: 1203,
    height: 269
  },
  maxWeight: 28000
};

// Items from user
// 9 roll 85*137,2 cm
// 3 roll 85*149,9 cm
// 26 roll 78*160 cm
// 1 roll 97*147,3 cm
// 1 roll 97*134,6 cm
// 10 roll 77*152,4 cm
// 8 roll 90*160,02 cm

const items: CargoItem[] = [
  { id: '1', name: 'Roll 85x137.2', type: 'cylinder', quantity: 9, dimensions: { width: 85, height: 137.2, length: 85, weight: 100 }, color: 'blue' },
  { id: '2', name: 'Roll 85x149.9', type: 'cylinder', quantity: 3, dimensions: { width: 85, height: 149.9, length: 85, weight: 100 }, color: 'blue' },
  { id: '3', name: 'Roll 78x160', type: 'cylinder', quantity: 26, dimensions: { width: 78, height: 160, length: 78, weight: 100 }, color: 'darkblue' },
  { id: '4', name: 'Roll 97x147.3', type: 'cylinder', quantity: 1, dimensions: { width: 97, height: 147.3, length: 97, weight: 100 }, color: 'red' },
  { id: '5', name: 'Roll 97x134.6', type: 'cylinder', quantity: 1, dimensions: { width: 97, height: 134.6, length: 97, weight: 100 }, color: 'red' },
  { id: '6', name: 'Roll 77x152.4', type: 'cylinder', quantity: 10, dimensions: { width: 77, height: 152.4, length: 77, weight: 100 }, color: 'green' },
  { id: '7', name: 'Roll 90x160.02', type: 'cylinder', quantity: 8, dimensions: { width: 90, height: 160.02, length: 90, weight: 100 }, color: 'purple' },
];

console.log('Running OptimizedCoilSolver...');
const solver = new OptimizedCoilSolver(container);
const result = solver.solve(items);

console.log(`Placed: ${result.placedCylinders.length}`);
console.log(`Unplaced: ${result.unplacedItems.length}`);

// Check for OOB
result.placedCylinders.forEach(p => {
  const xMin = p.position.x;
  const xMax = p.orientation === 'horizontal-x' ? xMin + p.length : xMin + p.radius * 2;
  const yMin = p.position.y;
  const yMax = p.orientation === 'horizontal-y' ? yMin + p.length : yMin + p.radius * 2;
  const zMin = p.position.z;
  const zMax = p.orientation === 'vertical' ? zMin + p.length : zMin + p.radius * 2;

  if (xMin < -0.1 || xMax > container.dimensions.width + 0.1 ||
      yMin < -0.1 || yMax > container.dimensions.length + 0.1 ||
      zMin < -0.1 || zMax > container.dimensions.height + 0.1) {
    console.error(`OOB DETECTED: ${p.item.name} at (${xMin}, ${yMin}, ${zMin}) [${p.orientation}]`);
    console.error(`  Bounds: X[${xMin}-${xMax}], Y[${yMin}-${yMax}], Z[${zMin}-${zMax}]`);
  }
});

// Analyze Gap
// Find Max Y of D78 (Area 1)
const d78s = result.placedCylinders.filter(c => Math.abs(c.radius * 2 - 78) < 1 && c.orientation === 'vertical');
const d78MaxY = Math.max(...d78s.map(c => c.position.y + c.radius * 2));
console.log(`Area 1 (D78) Ends at Y=${d78MaxY}`);

// Find Min Y of D85/D97 (Area 2)
const area2 = result.placedCylinders.filter(c => (Math.abs(c.radius * 2 - 85) < 1 || Math.abs(c.radius * 2 - 97) < 1) && c.orientation === 'vertical');
if (area2.length > 0) {
    const area2MinY = Math.min(...area2.map(c => c.position.y));
    console.log(`Area 2 (D85/D97) Starts at Y=${area2MinY}`);
    console.log(`Gap Size: ${area2MinY - d78MaxY}`);
} else {
    console.log('No Area 2 items placed vertically.');
}
