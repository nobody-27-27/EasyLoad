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

  // Güvenlik kontrolü
  if (!item) return null;

  // Renk seçimi
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

  // Three.js için Pozisyon Hesaplama
  let position: [number, number, number];

  if (item.center) {
    // Solver tarafından hesaplanmış hazır merkez noktası
    position = [item.center.x, item.center.y, item.center.z];
  } else {
    // Fallback: Eğer center yoksa manuel hesapla
    // Three.js Koordinatları: X=Genişlik, Y=Yükseklik, Z=Derinlik
    // Mantıksal Koordinatlar: X=Genişlik, Y=Derinlik, Z=Yükseklik
    
    // Varsayılan olarak (Kutular/Paletler için):
    // Görsel X = Logic X + Yarım Genişlik
    // Görsel Y = Logic Z + Yarım Yükseklik
    // Görsel Z = Logic Y + Yarım Derinlik
    
    const width = item.dimensions.width;
    const height = item.dimensions.height; 
    const length = item.dimensions.length; 

    // Rulo durumu
    let offsetX = width / 2;
    let offsetY = height / 2; // Logic Z (Yükseklik) -> Visual Y
    let offsetZ = length / 2; // Logic Y (Derinlik) -> Visual Z

    if (item.type === 'cylinder') {
       const r = width / 2;
       // Dikey rulo (Vertical): H=length, W=D, L=D
       if (Math.abs(item.rotation.x) < 0.1 && Math.abs(item.rotation.z) < 0.1) {
          offsetY = item.dimensions.height / 2; // Yükseklik boyudur
          offsetZ = r;
       }
       // Yatık rulo (Horizontal-Y):
       else if (Math.abs(item.rotation.x) > 0.1) {
          offsetY = r; // Yükseklik yarıçaptır
          offsetZ = item.dimensions.height / 2;
       }
       // Yatık rulo (Horizontal-X):
       else {
          offsetX = item.dimensions.height / 2;
          offsetY = r;
          offsetZ = r;
       }
    }

    position = [
      item.position.x + offsetX,
      item.position.z + offsetY, // Logic Z -> Visual Y (Yükseklik)
      item.position.y + offsetZ  // Logic Y -> Visual Z (Derinlik)
    ];
  }

  // Rotasyon (Array formatında)
  const rotation: [number, number, number] = [
    item.rotation.x,
    item.rotation.y,
    item.rotation.z
  ];

  // Boyutlar
  // Rulo için: width=çap, height=boy
  const radius = item.dimensions.width / 2;
  const cylHeight = item.dimensions.height;

  // Kutu boyutları
  const boxArgs: [number, number, number] = [
    item.dimensions.width,
    item.dimensions.height, // Visual Y (Height)
    item.dimensions.length  // Visual Z (Depth)
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
            {/* Silindir: [radiusTop, radiusBottom, height, segments] */}
            <cylinderGeometry args={[radius, radius, cylHeight, 32]} />
            <meshStandardMaterial
              color={hovered ? '#ffffff' : color}
              roughness={0.5}
              metalness={0.1}
              transparent={item.opacity !== undefined && item.opacity < 1}
              opacity={item.opacity ?? 1}
            />
            <lineSegments>
              <edgesGeometry args={[new THREE.CylinderGeometry(radius, radius, cylHeight, 32)]} />
              <lineBasicMaterial color="black" opacity={0.2} transparent />
            </lineSegments>
          </>
        ) : (
          <>
            {/* Kutu */}
            <boxGeometry args={boxArgs} />
            <meshStandardMaterial color={item.type === 'pallet' ? '#d97706' : color} />
            <lineSegments>
              <edgesGeometry args={[new THREE.BoxGeometry(...boxArgs)]} />
              <lineBasicMaterial color="black" opacity={0.3} transparent />
            </lineSegments>
          </>
        )}
      </mesh>

      {/* Etiket */}
      {hovered && (
        <Html position={[position[0], position[1] + (item.type === 'cylinder' ? cylHeight/2 : item.dimensions.height/2) + 10, position[2]]}>
          <div className="bg-black/80 text-white text-xs p-1 rounded whitespace-nowrap pointer-events-none z-50">
            {item.name} <br/>
            {Math.round(item.dimensions.width)}x{Math.round(item.dimensions.height)}
          </div>
        </Html>
      )}
    </group>
  );
};