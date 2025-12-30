// src/components/Scene3D.tsx
import React from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Center } from '@react-three/drei';
import { useStore } from '../store';
import { CargoItemView } from './CargoItemView';
import { ContainerView } from './ContainerView';

export const Scene3D: React.FC = () => {
  const { container, resultItems } = useStore();
  const gridSize =
    Math.max(container.dimensions.length, container.dimensions.width) * 2;

  return (
    <Canvas
      id="scene-canvas" // <--- EKLENDİ: Ekran görüntüsü almak için ID
      gl={{ preserveDrawingBuffer: true }} // <--- EKLENDİ: Ekran görüntüsü almak için ZORUNLU
      camera={{ position: [2000, 2000, 2000], fov: 45, far: 50000 }}
      style={{ background: '#e5e7eb', width: '100%', height: '100%' }}
    >
      <ambientLight intensity={1} />
      <directionalLight position={[1000, 2000, 1000]} intensity={1.5} />
      <pointLight position={[-1000, 1000, -1000]} intensity={0.5} />

      <OrbitControls makeDefault />

      {/* Center: Tırı ve yükleri otomatik olarak (0,0,0) noktasına ortalar */}
      <Center top>
        <group>
          <ContainerView container={container} />
          {resultItems.map((item) => (
            <CargoItemView key={item.uniqueId} item={item} />
          ))}
        </group>
      </Center>

      {/* Zemin Izgarası (Referans) */}
      <gridHelper
        args={[gridSize, 20, 0x444444, 0xbbbbbb]}
        position={[0, -10, 0]}
      />
      <axesHelper args={[500]} />
    </Canvas>
  );
};
