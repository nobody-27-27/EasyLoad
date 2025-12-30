// src/core/common/types.ts

/**
 * 3D uzayda boyut tanımları.
 * cm cinsinden çalışacağız.
 */
export interface Dimensions {
  width: number; // X Ekseni (En)
  length: number; // Y Ekseni (Boy/Derinlik)
  height: number; // Z Ekseni (Yükseklik)
}

/**
 * Uzaydaki bir noktanın veya vektörün tanımı.
 */
export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Yük Tipleri
 */
export type CargoType = 'box' | 'cylinder' | 'pallet';

/**
 * Kullanıcının gireceği HAM veri (Sipariş Listesi).
 */
export interface CargoItem {
  id: string; // Benzersiz ID (UUID)
  name: string; // Ürün adı
  type: CargoType; // Tip A, B, C
  quantity: number; // Adet
  color: string; // Görselleştirme rengi

  // Fiziksel Özellikler
  dimensions: Dimensions; // Rulo için: width=çap, length=çap, height=uzunluk
  weight?: number; // Gelecek versiyon (v2) için hazırlık

  // Kısıtlamalar
  stackable: boolean; // Üstüne başka ürün konabilir mi?
  maxStackWeight?: number; // Üstüne ne kadar yük binebilir? (v2)

  allowedRotation: {
    x: boolean; // Devrilebilir mi? (Genelde Rulo/Koli için)
    y: boolean; // Zemin ekseninde dönebilir mi? (90 derece)
    z: boolean; // (Nadir kullanılır)
  };
}

/**
 * Hesaplama sonucu yerleştirilmiş ürün.
 * CargoItem'ın tüm özelliklerini taşır + Koordinat bilgisi eklenir.
 */
export interface PlacedItem extends CargoItem {
  // Yerleşim Bilgisi
  position: Vector3; // Konteyner içindeki (x,y,z) koordinatı (Sol-Alt-Arka köşe)
  rotation: Vector3; // Dönüş açıları (Radyan cinsinden: 0, PI/2 vb.)

  // Takip Bilgisi
  uniqueId: string; // Her bir tekil kutu için ayrı ID (Örn: KoliA_1, KoliA_2)
  layerId?: number; // Hangi katmanda olduğu (Opsiyonel)
}

/**
 * Araç / Konteyner Tanımı
 */
export interface Container {
  name: string;
  type: 'Truck' | '40HC' | '40DC' | '20DC' | 'Custom';
  dimensions: Dimensions;
  maxWeight?: number;
}
