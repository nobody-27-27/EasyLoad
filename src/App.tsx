// src/App.tsx
import { ContainerForm } from './components/ContainerForm';
import { CargoInput } from './components/CargoInput';
import { Scene3D } from './components/Scene3D';
import { useStore } from './store';
import { ExportManager } from './core/infrastructure/export-manager';
import { ProjectControls } from './components/ProjectControls';
import { ResizableSidebar } from './components/ResizableSidebar';
import { ToastContainer } from './components/Toast';
import { LoadingOverlay } from './components/LoadingOverlay';
import { ResultsPanel } from './components/ResultsPanel';
import { CargoList } from './components/CargoList';

export default function App() {
  const {
    cargoList,
    removeCargo,
    runCalculation,
    isCalculating,
    resultItems,
    container,
    stats,
    unplacedSummary,
  } = useStore();

  const handleExport = () => {
    // 1. Canvas'i sarmalayan kutuyu (wrapper) bul
    const wrapper = document.getElementById('scene-canvas');

    // 2. Kutunun icindeki gercek <canvas> elementini bul
    const canvas = wrapper?.querySelector('canvas') as HTMLCanvasElement;

    let imgData = '';
    if (canvas) {
      try {
        // 3. Resmi al
        imgData = canvas.toDataURL('image/png');
      } catch (e) {
        console.error('Canvas goruntusu alinamadi:', e);
        // Hata olsa bile raporu resimsiz olusturmaya devam et
      }
    }

    // 4. Export Manager'i cagir
    ExportManager.generatePDF({
      container,
      stats,
      cargoList,
      resultItems,
      unplacedSummary,
      screenshotUrl: imgData,
    });
  };

  return (
    <>
      <ToastContainer />
      <div
        style={{ height: '100vh', width: '100vw' }}
        className="flex bg-gray-50 text-gray-800 font-sans overflow-hidden"
      >
      {/* SOL PANEL (KONTROLLER) - Resizable */}
      <ResizableSidebar defaultWidth={320} minWidth={280} maxWidth={600}>
        <div className="p-4 border-b border-gray-200 bg-blue-50">
          <h1 className="text-xl font-bold text-blue-800">3D Yukleme Sim</h1>
          <p className="text-xs text-blue-600">Profesyonel Optimizasyon v1.0</p>
        </div>

        <div className="p-4 space-y-4">
          <ContainerForm />
          <CargoInput />
          <CargoList cargoList={cargoList} onRemove={removeCargo} />
        </div>
        <div className="px-4 pb-2">
          <ProjectControls />
        </div>
        <div className="p-4 mt-auto border-t border-gray-200 bg-gray-50">
          <button
            onClick={runCalculation}
            disabled={isCalculating || cargoList.length === 0}
            className={`w-full py-3 rounded-lg font-bold text-lg shadow-md transition-transform transform active:scale-95 ${
              isCalculating
                ? 'bg-gray-400 text-white cursor-not-allowed'
                : 'bg-blue-600 text-white hover:bg-blue-700'
            }`}
          >
            {isCalculating ? 'Hesaplaniyor...' : 'HESAPLA'}
          </button>
        </div>
      </ResizableSidebar>

      {/* SAG PANEL (GORSELLESTIRME) */}
      <div className="flex-grow relative bg-gray-200">
        {/* Sahne Alani */}
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
          }}
        >
          <Scene3D />
        </div>

        {/* Loading Overlay */}
        {isCalculating && <LoadingOverlay />}

        {/* Bos Durum Mesaji */}
        {resultItems.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/80 p-8 rounded-xl text-center backdrop-blur-sm border border-gray-300 shadow-xl">
              <h2 className="text-2xl font-light text-gray-700">
                Simulasyon Alani
              </h2>
              <p className="text-gray-500 mt-2">Veri bekleniyor...</p>
            </div>
          </div>
        )}

        {/* Sonuc Paneli */}
        {resultItems.length > 0 && (
          <ResultsPanel
            stats={stats}
            container={container}
            unplacedSummary={unplacedSummary}
            onExport={handleExport}
          />
        )}
      </div>
      </div>
    </>
  );
}
