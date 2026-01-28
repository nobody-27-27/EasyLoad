// src/App.tsx
import { ContainerForm } from './components/ContainerForm';
import { CargoInput } from './components/CargoInput';
import { Scene3D } from './components/Scene3D';
import { useStore } from './store';
import { ExportManager } from './core/infrastructure/export-manager';
import { ProjectControls } from './components/ProjectControls';
import { ResizableSidebar } from './components/ResizableSidebar';
import { ToastContainer } from './components/Toast';

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
    // 1. Canvas'ı sarmalayan kutuyu (wrapper) bul
    const wrapper = document.getElementById('scene-canvas');

    // 2. Kutunun içindeki gerçek <canvas> elementini bul
    const canvas = wrapper?.querySelector('canvas') as HTMLCanvasElement;

    let imgData = '';
    if (canvas) {
      try {
        // 3. Resmi al
        imgData = canvas.toDataURL('image/png');
      } catch (e) {
        console.error('Canvas görüntüsü alınamadı:', e);
        // Hata olsa bile raporu resimsiz oluşturmaya devam et
      }
    }

    // 4. Export Manager'ı çağır
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
    // Arka planı BEYAZ (bg-gray-50) yapıyoruz.
    // 'h-screen' bazen çalışmaz, o yüzden style={{ height: '100vh' }} ile zorluyoruz.
    <>
      <ToastContainer />
      <div
        style={{ height: '100vh', width: '100vw' }}
        className="flex bg-gray-50 text-gray-800 font-sans overflow-hidden"
      >
      {/* SOL PANEL (KONTROLLER) - Resizable */}
      <ResizableSidebar defaultWidth={320} minWidth={280} maxWidth={600}>
        <div className="p-4 border-b border-gray-200 bg-blue-50">
          <h1 className="text-xl font-bold text-blue-800">3D Yükleme Sim</h1>
          <p className="text-xs text-blue-600">Profesyonel Optimizasyon v1.0</p>
        </div>

        <div className="p-4 space-y-4">
          <ContainerForm />
          <CargoInput />

          {/* Yük Listesi */}
          <div>
            <div className="flex justify-between items-center mb-2 border-b pb-1">
              <h4 className="text-sm font-bold text-gray-500">
                Yük Listesi ({cargoList.length})
              </h4>
              {cargoList.length > 0 && (
                <button
                  onClick={() => useStore.getState().reset()}
                  className="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 hover:bg-red-50 rounded transition-colors"
                >
                  Tümünü Temizle
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
                    onClick={() => removeCargo(item.id)}
                    className="text-red-500 hover:text-red-700 font-bold px-2"
                  >
                    ✕
                  </button>
                </li>
              ))}
              {cargoList.length === 0 && (
                <li className="text-xs text-gray-400 text-center italic">
                  Liste boş.
                </li>
              )}
            </ul>
          </div>
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
            {isCalculating ? 'Hesaplanıyor...' : 'HESAPLA'}
          </button>
        </div>
      </ResizableSidebar>

      {/* SAĞ PANEL (GÖRSELLEŞTİRME) */}
      <div className="flex-grow relative bg-gray-200">
        {/* Sahne Alanı - Mutlak Konumlandırma */}
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
        {isCalculating && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-50">
            <div className="bg-white p-8 rounded-2xl shadow-2xl flex flex-col items-center gap-4">
              {/* Spinner */}
              <div className="relative w-16 h-16">
                <div className="absolute inset-0 border-4 border-blue-200 rounded-full"></div>
                <div className="absolute inset-0 border-4 border-transparent border-t-blue-600 rounded-full animate-spin"></div>
              </div>
              <div className="text-center">
                <h3 className="text-lg font-bold text-gray-800">Hesaplanıyor...</h3>
                <p className="text-sm text-gray-500 mt-1">Optimum yerleşim aranıyor</p>
              </div>
              {/* Progress dots animation */}
              <div className="flex gap-1">
                <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '0ms' }}></div>
                <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '150ms' }}></div>
                <div className="w-2 h-2 bg-blue-600 rounded-full animate-bounce" style={{ animationDelay: '300ms' }}></div>
              </div>
            </div>
          </div>
        )}

        {/* Bilgi Kutucukları */}
        {resultItems.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="bg-white/80 p-8 rounded-xl text-center backdrop-blur-sm border border-gray-300 shadow-xl">
              <h2 className="text-2xl font-light text-gray-700">
                Simülasyon Alanı
              </h2>
              <p className="text-gray-500 mt-2">Veri bekleniyor...</p>
            </div>
          </div>
        )}

        {resultItems.length > 0 && (
          <div className="absolute top-4 right-4 bg-white/90 p-5 rounded-xl border border-gray-300 shadow-2xl backdrop-blur-md z-10 w-64">
            {/* Başlık */}
            <div className="flex items-center gap-2 mb-4 border-b border-gray-200 pb-2">
              <div className="w-3 h-3 rounded-full bg-green-500 animate-pulse"></div>
              <h3 className="font-bold text-gray-800">Optimizasyon Raporu</h3>
            </div>

            {/* İstatistikler */}
            <div className="space-y-3 text-sm text-gray-700">
              {/* 1. Progress Bar (Doluluk) */}
              <div>
                <div className="flex justify-between mb-1">
                  <span>Hacimsel Doluluk</span>
                  <span className="font-bold text-blue-600">
                    %{stats.fillRate}
                  </span>
                </div>
                <div className="w-full bg-gray-200 rounded-full h-2.5">
                  <div
                    className="bg-blue-600 h-2.5 rounded-full transition-all duration-1000"
                    style={{ width: `${stats.fillRate}%` }}
                  ></div>
                </div>
              </div>

              {/* 2. Detaylar */}
              <div className="grid grid-cols-2 gap-2 text-xs text-gray-500 mt-2">
                <div className="bg-gray-100 p-2 rounded">
                  <span className="block font-bold text-gray-800">
                    {stats.placedCount}/{stats.totalCount}
                  </span>
                  Yerleşen
                </div>
                <div className="bg-gray-100 p-2 rounded">
                  <span className="block font-bold text-gray-800">
                    {stats.usedVolume} m³
                  </span>
                  Yük Hacmi
                </div>
                <div className="bg-gray-100 p-2 rounded">
                  {/* Kalan Hacim */}
                  <span className="block font-bold text-gray-800">
                    {(stats.totalVolume - stats.usedVolume).toFixed(2)} m³
                  </span>
                  Boş Hacim
                </div>
                <div className="bg-gray-100 p-2 rounded">
                  {/* Araç Tipi */}
                  <span className="block font-bold text-gray-800 truncate">
                    {container.type}
                  </span>
                  Araç
                </div>
              </div>

              {/* 3. Yerleşmeyenler */}
              {unplacedSummary.length > 0 && (
                <div className="mt-3 p-2 bg-red-50 border border-red-200 rounded">
                  <div className="text-xs font-bold text-red-700 mb-1">
                    Yüklenemeyenler ({stats.unplacedCount}):
                  </div>
                  <ul className="text-xs text-red-600 space-y-0.5">
                    {unplacedSummary.map((item, idx) => (
                      <li key={idx}>• {item.count}x {item.name}</li>
                    ))}
                  </ul>
                </div>
              )}
              {/* PDF Butonu */}
              <button
                onClick={handleExport}
                className="w-full mt-4 bg-gray-800 hover:bg-gray-700 text-white py-2 rounded text-sm font-bold flex items-center justify-center gap-2 transition-colors"
              >
                <span>📄</span> PDF Raporu İndir
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
    </>
  );
}
