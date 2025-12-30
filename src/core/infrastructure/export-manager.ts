// src/core/infrastructure/export-manager.ts
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import type { Container, PlacedItem, CargoItem } from '../common/types';

interface ReportData {
  container: Container;
  stats: {
    totalVolume: number;
    usedVolume: number;
    fillRate: number;
    placedCount: number;
    totalCount: number;
  };
  cargoList: CargoItem[]; // Yüklenemeyenleri bulmak için
  resultItems: PlacedItem[];
  screenshotUrl?: string; // 3D sahnenin resmi
}

export class ExportManager {
  static generatePDF(data: ReportData) {
    const doc = new jsPDF();

    // --- BAŞLIK ---
    doc.setFontSize(18);
    doc.text('Yükleme Optimizasyon Raporu', 14, 20);

    doc.setFontSize(10);
    doc.setTextColor(100);
    doc.text(
      `Tarih: ${new Date().toLocaleDateString()} ${new Date().toLocaleTimeString()}`,
      14,
      26
    );

    // --- 1. ARAÇ BİLGİLERİ ---
    doc.setFontSize(14);
    doc.setTextColor(0);
    doc.text('1. Araç Bilgileri', 14, 40);

    const { width, length, height } = data.container.dimensions;
    const containerData = [
      ['Araç Tipi', data.container.type],
      ['İç Boyutlar', `${width} x ${length} x ${height} cm`],
      ['Toplam Hacim', `${data.stats.totalVolume} m³`],
    ];

    autoTable(doc, {
      startY: 45,
      head: [['Parametre', 'Değer']],
      body: containerData,
      theme: 'grid',
      headStyles: { fillColor: [41, 128, 185] },
      styles: { fontSize: 10 },
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 50 } },
    });

    // --- 2. YÜKLEME İSTATİSTİKLERİ ---
    const finalY = (doc as any).lastAutoTable.finalY + 15;
    doc.setFontSize(14);
    doc.text('2. Optimizasyon Sonucu', 14, finalY);

    const statsData = [
      [
        'Toplam Yük Adedi',
        `${data.stats.placedCount} / ${data.stats.totalCount}`,
      ],
      ['Yüklenen Hacim', `${data.stats.usedVolume} m³`],
      ['Doluluk Oranı', `%${data.stats.fillRate}`],
      [
        'Kalan Boşluk',
        `${(data.stats.totalVolume - data.stats.usedVolume).toFixed(2)} m³`,
      ],
    ];

    autoTable(doc, {
      startY: finalY + 5,
      body: statsData,
      theme: 'striped',
      showHead: 'never',
      columnStyles: { 0: { fontStyle: 'bold', cellWidth: 50 } },
    });

    // --- 3. GÖRSEL (SCREENSHOT) ---
    // Eğer resim verisi geldiyse sayfaya ekle
    if (data.screenshotUrl) {
      const imgY = (doc as any).lastAutoTable.finalY + 15;
      doc.setFontSize(14);
      doc.text('3. 3D Yerleşim Görünümü', 14, imgY);

      // Resmi ortala ve sığdır
      const imgWidth = 180;
      const imgHeight = 100;
      doc.addImage(
        data.screenshotUrl,
        'PNG',
        15,
        imgY + 5,
        imgWidth,
        imgHeight
      );

      // Bir sonraki sayfa için imleci ayarla (Gerekirse)
      // Ancak tek sayfa sığıyorsa sorun yok, sığmazsa jspdf yeni sayfa açar.
    }

    // --- 4. YÜK LİSTESİ (Detaylı Tablo) ---
    // Resimden sonra veya yeni sayfada
    doc.addPage();
    doc.setFontSize(14);
    doc.text('4. Yükleme Detay Listesi', 14, 20);

    // Veriyi hazırla
    const tableRows = data.resultItems.map((item, index) => [
      index + 1,
      item.name,
      item.type.toUpperCase(),
      `${item.dimensions.width}x${item.dimensions.length}x${item.dimensions.height}`,
      `X:${Math.round(item.position.x)} Y:${Math.round(
        item.position.y
      )} Z:${Math.round(item.position.z)}`,
    ]);

    autoTable(doc, {
      startY: 25,
      head: [['#', 'Ürün Adı', 'Tip', 'Boyut (cm)', 'Konum (cm)']],
      body: tableRows,
      theme: 'grid',
      styles: { fontSize: 8 },
      headStyles: { fillColor: [52, 73, 94] },
    });

    // --- KAYDET ---
    doc.save(`yukleme-plani-${Date.now()}.pdf`);
  }
}
