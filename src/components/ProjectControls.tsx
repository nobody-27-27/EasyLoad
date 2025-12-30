// src/components/ProjectControls.tsx
import React, { useRef } from 'react';
import { useStore } from '../store';
import { showToast } from './Toast';

export const ProjectControls: React.FC = () => {
  const { container, cargoList, loadProject } = useStore();
  const fileInputRef = useRef<HTMLInputElement>(null);

  // --- PROJEYİ KAYDET (Export JSON) ---
  const handleSave = () => {
    const projectData = {
      container,
      cargoList,
      date: new Date().toISOString(),
      version: '1.0',
    };

    const dataStr =
      'data:text/json;charset=utf-8,' +
      encodeURIComponent(JSON.stringify(projectData));
    const downloadAnchorNode = document.createElement('a');
    downloadAnchorNode.setAttribute('href', dataStr);
    downloadAnchorNode.setAttribute(
      'download',
      `proje_${new Date().getTime()}.json`
    );
    document.body.appendChild(downloadAnchorNode);
    downloadAnchorNode.click();
    downloadAnchorNode.remove();
  };

  // --- PROJE YÜKLE (Import JSON) ---
  const handleLoad = (event: React.ChangeEvent<HTMLInputElement>) => {
    const fileReader = new FileReader();
    const { files } = event.target;

    if (files && files.length > 0) {
      fileReader.readAsText(files[0], 'UTF-8');
      fileReader.onload = (e) => {
        const content = e.target?.result;
        try {
          if (typeof content === 'string') {
            const parsedData = JSON.parse(content);
            // Basit bir doğrulama: içinde cargoList var mı?
            if (parsedData.cargoList) {
              loadProject(parsedData);
              showToast("Proje yüklendi! 'HESAPLA' butonuna basın.", 'success');
            } else {
              showToast('Geçersiz proje dosyası!', 'error');
            }
          }
        } catch (error) {
          console.error(error);
          showToast('Dosya okunamadı!', 'error');
        }
      };
    }
    // Input'u temizle ki aynı dosyayı tekrar seçebilelim
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="flex gap-2 mt-4 pt-4 border-t border-gray-200">
      <button
        onClick={handleSave}
        disabled={cargoList.length === 0}
        className={`flex-1 py-2 px-3 rounded text-sm font-bold border ${
          cargoList.length === 0
            ? 'border-gray-300 text-gray-400 cursor-not-allowed'
            : 'border-blue-600 text-blue-600 hover:bg-blue-50'
        }`}
      >
        💾 Kaydet
      </button>

      <button
        onClick={() => fileInputRef.current?.click()}
        className="flex-1 py-2 px-3 rounded text-sm font-bold border border-gray-400 text-gray-700 hover:bg-gray-100"
      >
        📂 Aç
      </button>

      {/* Gizli Dosya Input */}
      <input
        type="file"
        accept=".json"
        ref={fileInputRef}
        style={{ display: 'none' }}
        onChange={handleLoad}
      />
    </div>
  );
};
