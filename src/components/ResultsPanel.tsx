import React from 'react';
import type { Container, UnplacedSummary, LoadingStats } from '../core/common/types';

interface ResultsPanelProps {
  stats: LoadingStats;
  container: Container;
  unplacedSummary: UnplacedSummary[];
  onExport: () => void;
}

export const ResultsPanel: React.FC<ResultsPanelProps> = ({
  stats,
  container,
  unplacedSummary,
  onExport,
}) => (
  <div className="absolute top-4 right-4 bg-white/90 p-5 rounded-xl border border-gray-300 shadow-2xl backdrop-blur-md z-10 w-64">
    <div className="flex items-center gap-2 mb-4 border-b border-gray-200 pb-2">
      <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
      <h3 className="font-bold text-gray-800">Optimizasyon Raporu</h3>
    </div>

    <div className="space-y-3 text-sm text-gray-700">
      <div>
        <div className="flex justify-between mb-1">
          <span>Hacimsel Doluluk</span>
          <span className="font-bold text-blue-600">%{stats.fillRate}</span>
        </div>
        <div className="w-full bg-gray-200 rounded-full h-2.5">
          <div
            className="bg-blue-600 h-2.5 rounded-full transition-all duration-1000"
            style={{ width: `${stats.fillRate}%` }}
          ></div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 mt-2">
        <div className="bg-gray-100 p-2 rounded">
          <span className="block font-bold text-gray-800">
            {stats.placedCount}/{stats.totalCount}
          </span>
          Yerlesen
        </div>
        <div className="bg-gray-100 p-2 rounded">
          <span className="block font-bold text-gray-800">
            {stats.usedVolume} m3
          </span>
          Yuk Hacmi
        </div>
        <div className="bg-gray-100 p-2 rounded">
          <span className="block font-bold text-gray-800">
            {(stats.totalVolume - stats.usedVolume).toFixed(2)} m3
          </span>
          Bos Hacim
        </div>
        <div className="bg-gray-100 p-2 rounded">
          <span className="block font-bold text-gray-800 truncate">
            {container.type}
          </span>
          Arac
        </div>
      </div>

      {unplacedSummary.length > 0 && (
        <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded">
          <div className="text-xs font-bold text-red-700 mb-1">
            Yuklenemeyenler ({stats.unplacedCount}):
          </div>
          <ul className="text-xs text-red-600 space-y-0.5">
            {unplacedSummary.map((item, idx) => (
              <li key={idx}>* {item.count}x {item.name}</li>
            ))}
          </ul>
        </div>
      )}

      <button
        onClick={onExport}
        className="w-full mt-4 bg-gray-800 hover:bg-gray-700 text-white py-2 rounded text-sm font-bold flex items-center justify-center gap-2 transition-colors"
      >
        PDF Raporu Indir
      </button>
    </div>
  </div>
);
