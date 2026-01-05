// src/components/Scene3D.tsx
import React, { Suspense } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Center, Environment } from '@react-three/drei';
import { useStore } from '../store';
import { CargoItemView } from './CargoItemView';
import { ContainerView } from './ContainerView';

export const Scene3D: React.FC = () => {
  const { container, resultItems } = useStore();
  const gridSize = Math.max(container.dimensions.length, container.dimensions.width) * 2;

  return (
    <Canvas
      id="scene-canvas"
      gl={{ preserveDrawingBuffer: true, antialias: true }}
      camera={{ position: [1000, 1500, 2000], fov: 50, far: 50000 }} // Kamera biraz daha uzak ve geniş açı
      style={{ background: '#f0f2f5', width: '100%', height: '100%' }}
      shadows
    >
      <Suspense fallback={null}>
        <ambientLight intensity={0.6} />
        <directionalLight 
          position={[1500, 3000, 1500]} 
          intensity={1.2} 
          castShadow 
          shadow-mapSize={[2048, 2048]}
        />
        <pointLight position={[-1000, 1000, -1000]} intensity={0.5} />
        
        {/* Çevre aydınlatması (daha gerçekçi metalik yansımalar için) */}
        <Environment preset="city" />

        <OrbitControls makeDefault dampingFactor={0.1} />

        <Center top>
          <group>
            <ContainerView container={container} />
            {resultItems.map((item) => (
              <CargoItemView key={item.uniqueId} item={item} />
            ))}
          </group>
        </Center>

        <gridHelper
          args={[gridSize, 40, 0x999999, 0xdddddd]}
          position={[0, -5, 0]}
        />
        <axesHelper args={[200]} />
      </Suspense>
    </Canvas>
  );
};