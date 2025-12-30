// src/components/ContainerForm.tsx
import React from 'react';
import { useStore } from '../store';
import { CONTAINER_PRESETS } from '../core/common/constants';

export const ContainerForm: React.FC = () => {
  const { container, setContainer } = useStore();

  // Dropdown değişince (Preset seçimi)
  const handlePresetChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const selectedType = e.target.value;
    // Preset seçilirse store o presetin ölçülerini yükler
    setContainer(selectedType);
  };

  // Input değişince (Manuel ölçü girişi)
  const handleDimensionChange = (
    key: 'width' | 'length' | 'height',
    value: string
  ) => {
    const numValue = Number(value);

    // Yeni ölçüleri oluştur
    const newDimensions = {
      ...container.dimensions,
      [key]: numValue,
    };

    // Store'a "Custom" tipiyle ve yeni ölçülerle gönder
    // Bu sayede dropdown otomatik olarak "Custom"a döner
    setContainer('Custom', newDimensions);
  };

  return (
    <div className="p-4 bg-blue-50 border-b border-gray-200">
      <h3 className="font-bold mb-3 text-blue-800 text-sm uppercase tracking-wide">
        Araç Yapılandırması
      </h3>

      <div className="flex flex-col gap-3">
        {/* Araç Tipi Seçimi */}
        <div>
          <label className="text-xs font-bold text-gray-500 mb-1 block">
            Araç Tipi
          </label>
          <select
            value={container.type}
            onChange={handlePresetChange}
            className="w-full bg-white p-2 rounded border border-gray-300 text-gray-700 focus:outline-none focus:border-blue-500 text-sm font-medium"
          >
            {Object.values(CONTAINER_PRESETS).map((preset) => (
              <option key={preset.type} value={preset.type}>
                {preset.name}
              </option>
            ))}
            {/* Eğer listede yoksa Custom seçeneğini ekle */}
            {!Object.keys(CONTAINER_PRESETS).includes(container.type) && (
              <option value="Custom">Özel Boyut (Custom)</option>
            )}
            <option value="Custom">Özel Tanımla...</option>
          </select>
        </div>

        {/* Boyut Inputları (Artık Düzenlenebilir) */}
        <div className="grid grid-cols-3 gap-2">
          {/* GENİŞLİK */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Genişlik</label>
            <div className="relative">
              <input
                type="number"
                value={container.dimensions.width}
                onChange={(e) => handleDimensionChange('width', e.target.value)}
                className="w-full bg-white p-2 pr-6 rounded border border-gray-300 text-gray-800 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-500 outline-none transition-all font-bold"
              />
              <span className="absolute right-1 top-2 text-xs text-gray-400 pointer-events-none">
                cm
              </span>
            </div>
          </div>

          {/* UZUNLUK */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">Uzunluk</label>
            <div className="relative">
              <input
                type="number"
                value={container.dimensions.length}
                onChange={(e) =>
                  handleDimensionChange('length', e.target.value)
                }
                className="w-full bg-white p-2 pr-6 rounded border border-gray-300 text-gray-800 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-500 outline-none transition-all font-bold"
              />
              <span className="absolute right-1 top-2 text-xs text-gray-400 pointer-events-none">
                cm
              </span>
            </div>
          </div>

          {/* YÜKSEKLİK */}
          <div>
            <label className="block text-xs text-gray-400 mb-1">
              Yükseklik
            </label>
            <div className="relative">
              <input
                type="number"
                value={container.dimensions.height}
                onChange={(e) =>
                  handleDimensionChange('height', e.target.value)
                }
                className="w-full bg-white p-2 pr-6 rounded border border-gray-300 text-gray-800 text-sm focus:ring-2 focus:ring-blue-200 focus:border-blue-500 outline-none transition-all font-bold"
              />
              <span className="absolute right-1 top-2 text-xs text-gray-400 pointer-events-none">
                cm
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
