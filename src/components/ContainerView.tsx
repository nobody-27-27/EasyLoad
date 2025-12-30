// src/components/ContainerView.tsx
import React from 'react';
import * as THREE from 'three';
import type { Container } from '../core/common/types';

interface Props {
  container: Container;
}

export const ContainerView: React.FC<Props> = ({ container }) => {
  const { width, length, height } = container.dimensions;

  // Tırın Merkezi (Three.js'de Y yukarıdır, Z derinliktir)
  // Logic Z -> Scene Y
  // Logic Y -> Scene Z
  const position: [number, number, number] = [
    width / 2,
    height / 2,
    length / 2,
  ];

  return (
    <group position={position}>
      {/* 1. Yarı Şeffaf Gri Duvarlar (Hacmi hissettirir) */}
      <mesh>
        <boxGeometry args={[width, height, length]} />
        <meshStandardMaterial
          color="#9ca3af" // Tailwind gray-400
          transparent
          opacity={0.2}
        />
      </mesh>

      {/* 2. Belirgin Kırmızı Çerçeve */}
      <lineSegments>
        <edgesGeometry args={[new THREE.BoxGeometry(width, height, length)]} />
        <lineBasicMaterial color="#ef4444" linewidth={2} />
      </lineSegments>
    </group>
  );
};
