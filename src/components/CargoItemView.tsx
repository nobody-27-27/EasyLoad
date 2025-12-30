// src/components/CargoItemView.tsx
import React from 'react';
import * as THREE from 'three';
import type { PlacedItem } from '../core/common/types';

interface Props {
  item: PlacedItem;
}

export const CargoItemView: React.FC<Props> = ({ item }) => {
  const width = item.dimensions.width;
  const height = item.dimensions.height;
  const length = item.dimensions.length;
  const color = item.type === 'pallet' ? '#d97706' : item.color;

  // --- MERKEZLEME MANTIĞI (OFFSET) ---
  // Three.js nesneleri merkezden çizer, biz sol-alt köşeden koordinat veriyoruz.
  // Bu yüzden yarıçap/yarı-boyut kadar ötelemeliyiz.

  let offsetX = width / 2;
  let offsetY = length / 2; // Derinlik Offseti (Logic Y -> Scene Z)
  let offsetZ = height / 2; // Yükseklik Offseti (Logic Z -> Scene Y)

  // RULO ÖZEL DURUMU:
  // Eğer rulo yatıksa (Rotation X varsa), boyut algısı değişir.
  // Görsel Yükseklik (Scene Y) artık Çap (Width) olur.
  // Görsel Derinlik (Scene Z) artık Boy (Height) olur.

  if (item.type === 'cylinder' && item.rotation.x !== 0) {
    // YATIK RULO
    offsetZ = width / 2; // Yükseklik artık çaptır (Yarıçap kadar kaldır)
    offsetY = height / 2; // Derinlik artık rulonun boyudur
  }

  const position: [number, number, number] = [
    item.position.x + offsetX,
    item.position.z + offsetZ, // Düzeltilmiş Yükseklik
    item.position.y + offsetY, // Düzeltilmiş Derinlik
  ];

  return (
    <group position={position}>
      {item.type === 'cylinder' ? (
        // --- RULO ---
        // item.rotation doğrudan solver'dan geliyor.
        <mesh rotation={[item.rotation.x, item.rotation.y, item.rotation.z]}>
          <cylinderGeometry args={[width / 2, width / 2, height, 32]} />
          <meshStandardMaterial color={color} />
          <lineSegments>
            <edgesGeometry
              args={[
                new THREE.CylinderGeometry(width / 2, width / 2, height, 32),
              ]}
            />
            <lineBasicMaterial color="black" transparent opacity={0.3} />
          </lineSegments>
        </mesh>
      ) : (
        // --- KUTU / PALET ---
        <mesh>
          <boxGeometry args={[width, height, length]} />
          <meshStandardMaterial color={color} />
          <lineSegments>
            <edgesGeometry
              args={[new THREE.BoxGeometry(width, height, length)]}
            />
            <lineBasicMaterial color="black" transparent opacity={0.5} />
          </lineSegments>
        </mesh>
      )}
    </group>
  );
};
