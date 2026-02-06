import React from 'react';
import { useStore } from '../store';
import type { CargoItem } from '../core/common/types';

interface CargoListProps {
  cargoList: CargoItem[];
  onRemove: (id: string) => void;
}

export const CargoList: React.FC<CargoListProps> = ({ cargoList, onRemove }) => (
  <div>
    <div className="flex justify-between items-center mb-2 border-b pb-1">
      <h4 className="text-sm font-bold text-gray-500">
        Yuk Listesi ({cargoList.length})
      </h4>
      {cargoList.length > 0 && (
        <button
          onClick={() => useStore.getState().reset()}
          className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 hover:bg-red-50 rounded transition-colors"
        >
          Tumunu Temizle
        </button>
      )}
    </div>
    <ul className="space-y-2 max-h-60 overflow-y-auto pr-1">
      {cargoList.map((item) => (
        <li
          key={item.id}
          className="flex justify-between items-center bg-gray-100 p-2 rounded text-sm border-l-4 shadow-sm"
          style={{ borderLeftColor: item.color }}
        >
          <div>
            <span className="font-bold text-gray-700">
              {item.quantity}x {item.name}
            </span>
            <span className="text-xs text-gray-500 block">
              {item.dimensions.width}x{item.dimensions.length}x
              {item.dimensions.height}
            </span>
          </div>
          <button
            onClick={() => onRemove(item.id)}
            className="text-red-500 hover:text-red-700 font-bold px-2"
          >
            X
          </button>
        </li>
      ))}
      {cargoList.length === 0 && (
        <li className="text-xs text-gray-400 text-center italic">
          Liste bos.
        </li>
      )}
    </ul>
  </div>
);
