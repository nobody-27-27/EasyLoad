// src/components/CargoItemView.tsx
import React, { useRef, useMemo } from 'react';
import { useFrame } from '@react-three/fiber';
import { Text, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { PlacedCylinder } from '../core/solvers/coil-solver/types';

interface Props {
  item: PlacedCylinder;
}

export const CargoItemView: React.FC<Props> = ({ item }) => {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHover] = React.useState(false);

  // GÜVENLİK KONTROLÜ: Eğer item veya item.item yoksa null dön (render etme)
  if (!item || !item.item) {
    return null;
  }

  // Renk seçimi (katmana göre veya rastgele)
  const color = useMemo(() => {
    // Güvenli erişim (?) kullanarak item.item.color kontrolü
    if (item.item?.color && item.item.color !== '#cccccc') {
      return item.item.color;
    }
    
    // Varsayılan renk paleti
    const colors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];
    
    // Hash üretimi için güvenli string alma
    let hash = 0;
    // item.item.id yoksa uniqueId kullan, o da yoksa 'default' kullan
    const str = item.item?.id || item.uniqueId || 'default';
    
    for (let i = 0; i < str.length; i++) {
      hash = str.charCodeAt(i) + ((hash << 5) - hash);
    }
    return colors[Math.abs(hash) % colors.length];
  }, [item.item?.id, item.uniqueId, item.item?.color]);

  // Three.js için pozisyon ve rotasyon array'leri
  // item.center yoksa item.position (köşe) kullan, o da yoksa [0,0,0]
  const centerX = item.center?.x ?? item.position?.x ?? 0;
  const centerY = item.center?.y ?? item.position?.y ?? 0;
  const centerZ = item.center?.z ?? item.position?.z ?? 0;

  const position: [number, number, number] = [centerX, centerY, centerZ];

  // Rotasyon güvenliği
  const rotation: [number, number, number] = [
    item.rotation?.x ?? 0,
    item.rotation?.y ?? 0,
    item.rotation?.z ?? 0
  ];

  // Boyut güvenliği
  const radius = item.radius || (item.item.dimensions ? item.item.dimensions.width / 2 : 50);
  const length = item.length || (item.item.dimensions ? item.item.dimensions.height : 100);

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
        onPointerOut={(e) => {
          setHover(false);
        }}
      >
        {/* Silindir Geometrisi: [radiusTop, radiusBottom, height, segments] */}
        <cylinderGeometry args={[radius, radius, length, 32]} />
        <meshStandardMaterial
          color={hovered ? '#ffffff' : color}
          roughness={0.5}
          metalness={0.1}
          transparent={item.item.opacity !== undefined && item.item.opacity < 1}
          opacity={item.item.opacity ?? 1}
        />
        
        {/* Kenar Çizgileri */}
        <lineSegments>
          <edgesGeometry args={[new THREE.CylinderGeometry(radius, radius, length, 32)]} />
          <lineBasicMaterial color="black" opacity={0.2} transparent />
        </lineSegments>
      </mesh>

      {/* Etiket */}
      {hovered && item.item.name && (
        <Html position={[0, length / 2 + 10, 0]} distanceFactor={1000}>
           {/* Html position is relative to the group/mesh if inside it, but here we render relative to mesh center */}
          <div className="bg-black/80 text-white text-xs p-1 rounded whitespace-nowrap pointer-events-none">
            {item.item.name} <br/>
            {Math.round(item.item.dimensions?.width ?? 0)}x{Math.round(item.item.dimensions?.height ?? 0)}
          </div>
        </Html>
      )}
    </group>
  );
};