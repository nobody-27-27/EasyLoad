// src/components/CargoItemView.tsx
import React, { useRef, useMemo } from 'react';
import { Html } from '@react-three/drei';
import * as THREE from 'three';
import type { PlacedItem } from '../core/common/types';

interface Props {
  item: PlacedItem;
}

export const CargoItemView: React.FC<Props> = ({ item }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHover] = React.useState(false);

  if (!item) return null;

  const color = useMemo(() => {
    if (item.color && item.color !== '#cccccc') return item.color;
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    let hash = 0;
    const str = item.id || item.uniqueId || 'default';
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }, [item.id, item.uniqueId, item.color]);

  // Position Logic
  let posX = 0, posY = 0, posZ = 0;

  if (item.center) {
    // Use Solver's calculated center (Visual Coordinates)
    posX = Number(item.center.x);
    posY = Number(item.center.y);
    posZ = Number(item.center.z);
  } else if (item.position) {
    // Fallback: Calculate from Corner position
    const width = Number(item.dimensions?.width || 0);
    const height = Number(item.dimensions?.height || 0);
    const length = Number(item.dimensions?.length || 0);

    let offsetX = width / 2;
    let visualYOffset = height / 2;
    let visualZOffset = length / 2;

    if (item.type === 'cylinder') {
       const r = width / 2;
       const rotX = Math.abs(Number(item.rotation?.x || 0));
       
       if (rotX > 0.1) {
          visualYOffset = r; 
          visualZOffset = height / 2;
       } else {
          visualYOffset = height / 2;
          visualZOffset = r;
       }
    }

    posX = Number(item.position.x) + offsetX;
    posY = Number(item.position.z) + visualYOffset; // Swap Logic Z -> Visual Y
    posZ = Number(item.position.y) + visualZOffset; // Swap Logic Y -> Visual Z
  }

  const position: [number, number, number] = [posX, posY, posZ];

  const rotation: [number, number, number] = [
    Number(item.rotation?.x || 0),
    Number(item.rotation?.y || 0),
    Number(item.rotation?.z || 0)
  ];

  const radius = Number(item.dimensions?.width || 0) / 2;
  const cylHeight = Number(item.dimensions?.height || 0);
  
  const boxArgs: [number, number, number] = [
    Number(item.dimensions?.width || 0),
    Number(item.dimensions?.height || 0),
    Number(item.dimensions?.length || 0)
  ];

  return (
    <group>
      <mesh
        ref={meshRef}
        position={position}
        rotation={rotation}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHover(true);
        }}
        onPointerOut={() => setHover(false)}
      >
        {item.type === 'cylinder' ? (
          <>
            <cylinderGeometry args={[radius, radius, cylHeight, 32]} />
            <meshStandardMaterial
              color={hovered ? '#ffffff' : color}
              roughness={0.5}
              metalness={0.1}
              opacity={Number(item.opacity ?? 1)}
              transparent={Number(item.opacity ?? 1) < 1}
            />
            <lineSegments>
              <edgesGeometry args={[new THREE.CylinderGeometry(radius, radius, cylHeight, 32)]} />
              <lineBasicMaterial color="black" opacity={0.2} transparent />
            </lineSegments>
          </>
        ) : (
          <>
            <boxGeometry args={boxArgs} />
            <meshStandardMaterial color={item.type === 'pallet' ? '#d97706' : color} />
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(...boxArgs)]} />
              <lineBasicMaterial color="black" opacity={0.3} transparent />
            </lineSegments>
          </>
        )}
      </mesh>

      {hovered && (
        <Html position={[0, (item.type === 'cylinder' ? cylHeight/2 : Number(item.dimensions?.height)/2) + 10, 0]}>
          <div className="bg-black/80 text-white text-xs p-1 rounded whitespace-nowrap pointer-events-none z-50">
            {item.name} <br/>
            {Math.round(radius*2)}x{Math.round(cylHeight)}
          </div>
        </Html>
      )}
    </group>
  );
};