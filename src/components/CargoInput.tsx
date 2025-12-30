// src/components/CargoInput.tsx
import React, { useState } from 'react';
import { useStore } from '../store';
import type { CargoType } from '../core/common/types';

const generateRandomColor = () => {
  const letters = '0123456789ABCDEF';
  let color = '#';
  for (let i = 0; i < 6; i++) {
    color += letters[Math.floor(Math.random() * 16)];
  }
  return color;
};

export const CargoInput: React.FC = () => {
  const addCargo = useStore((state) => state.addCargo);

  const [type, setType] = useState<CargoType>('box');
  const [qty, setQty] = useState(1);
  const [dims, setDims] = useState({ w: 60, l: 40, h: 40 });
  const [color, setColor] = useState('#3b82f6');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const finalDims = {
      // Rulo ise En (w) Çap demektir.
      width: Number(dims.w),
      // Rulo ise Boy (l) da Çap'a eşittir (Tabanı kare/daire olduğu için).
      length: type === 'cylinder' ? Number(dims.w) : Number(dims.l),
      height: Number(dims.h),
    };

    addCargo({
      name: `${
        type === 'cylinder' ? 'RULO' : type === 'pallet' ? 'PALET' : 'KOLİ'
      } ${dims.w}x${dims.h}`,
      type,
      quantity: Number(qty),
      color,
      dimensions: finalDims,
      stackable: type !== 'pallet',
      allowedRotation: {
        x: type !== 'pallet',
        y: true, // Rulo için bu özellik, dik durma/yatay durma iznini yönetir
        z: false,
      },
    });

    setColor(generateRandomColor());
  };

  return (
    <div className="p-4 bg-white border border-gray-200 rounded-lg shadow-sm">
      <h3 className="font-bold mb-3 text-gray-700 text-sm border-b pb-2">
        Yük Ekle
      </h3>
      <form onSubmit={handleSubmit} className="flex flex-col gap-3">
        {/* Tip Seçimi */}
        <div className="flex gap-1 bg-gray-100 p-1 rounded">
          {(['box', 'cylinder', 'pallet'] as CargoType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setType(t)}
              className={`flex-1 py-1 text-xs font-bold rounded transition-colors ${
                type === t
                  ? 'bg-white text-blue-600 shadow-sm border border-gray-200'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {t === 'box' ? 'Koli' : t === 'cylinder' ? 'Rulo' : 'Palet'}
            </button>
          ))}
        </div>

        {/* Boyutlar - DİNAMİK ETİKETLER */}
        <div className="grid grid-cols-3 gap-2">
          <div>
            {/* Rulo seçiliyse 'Çap', değilse 'En' yazar */}
            <label className="text-xs font-bold text-gray-400">
              {type === 'cylinder' ? 'Çap (cm)' : 'En (cm)'}
            </label>
            <input
              required
              type="number"
              value={dims.w}
              onChange={(e) => setDims({ ...dims, w: Number(e.target.value) })}
              className="w-full bg-gray-50 p-2 rounded border border-gray-300 text-sm focus:border-blue-500 outline-none"
            />
          </div>

          {/* Rulo ise Boy inputunu gizle */}
          {type !== 'cylinder' && (
            <div>
              <label className="text-xs font-bold text-gray-400">
                Boy (cm)
              </label>
              <input
                required
                type="number"
                value={dims.l}
                onChange={(e) =>
                  setDims({ ...dims, l: Number(e.target.value) })
                }
                className="w-full bg-gray-50 p-2 rounded border border-gray-300 text-sm focus:border-blue-500 outline-none"
              />
            </div>
          )}

          <div className={type === 'cylinder' ? 'col-span-2' : ''}>
            <label className="text-xs font-bold text-gray-400">
              Yükseklik (cm)
            </label>
            <input
              required
              type="number"
              value={dims.h}
              onChange={(e) => setDims({ ...dims, h: Number(e.target.value) })}
              className="w-full bg-gray-50 p-2 rounded border border-gray-300 text-sm focus:border-blue-500 outline-none"
            />
          </div>
        </div>

        {/* Adet ve Renk */}
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs font-bold text-gray-400">Adet</label>
            <input
              type="number"
              min="1"
              value={qty}
              onChange={(e) => setQty(Number(e.target.value))}
              className="w-full bg-gray-50 p-2 rounded border border-gray-300 text-sm focus:border-blue-500 outline-none"
            />
          </div>
          <div>
            <label className="text-xs font-bold text-gray-400">Renk</label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-8 h-8 rounded cursor-pointer border-none p-0 overflow-hidden"
              />
              <span className="text-xs text-gray-400 font-mono uppercase">
                {color}
              </span>
            </div>
          </div>
        </div>

        <button
          type="submit"
          className="bg-green-600 hover:bg-green-700 text-white py-2 rounded font-bold text-sm transition-colors shadow-sm"
        >
          Listeye Ekle
        </button>
      </form>
    </div>
  );
};
