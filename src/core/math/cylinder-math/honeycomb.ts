// src/core/math/cylinder-math/honeycomb.ts

/**
 * Rulo İstifleme Matematiği
 * 2D Düzlemde (Kesit görünümü) dairelerin birbirine oturmasını hesaplar.
 */
export class HoneycombMath {
  /**
   * Bal Peteği Pozisyonu Hesapla
   * Zemindeki iki rulonun (A ve B) üzerine konacak C rulosunun merkez koordinatlarını bulur.
   * * @param c1 - 1. Alt Rulonun Merkezi (x, z) - Y ekseni derinlik olduğu için X ve Z kullanıyoruz (Dik rulo)
   * @param r1 - 1. Alt Rulonun Yarıçapı
   * @param c2 - 2. Alt Rulonun Merkezi (x, z)
   * @param r2 - 2. Alt Rulonun Yarıçapı
   * @param r3 - Üste konacak rulonun Yarıçapı
   */
  static calculateNestPosition(
    c1: { x: number; z: number },
    r1: number,
    c2: { x: number; z: number },
    r2: number,
    r3: number
  ): { x: number; z: number } | null {
    // İki alt rulo arasındaki merkez mesafesi
    const dx = c2.x - c1.x;
    const dz = c2.z - c1.z;
    const dist = Math.sqrt(dx * dx + dz * dz);

    // Eğer rulolar birbirinden çok uzaksa üstlerine rulo konamaz (Düşer)
    // Maksimum mesafe: Üst rulo araya girdiğinde teğet olmalı.
    if (dist > r1 + r3 + (r2 + r3)) return null;

    // Basitleştirme:
    // Bu proje kapsamında ruloların yan yana (Zemin ekseninde) dizildiğini varsayıyoruz.
    // Yani Z (Yükseklik) değil, X (Genişlik) ekseninde yan yanalar.
    // C1(0,0), C2(d,0) gibi düşünelim.

    // Üçgen Kenar Uzunlukları
    const a = r1 + r3; // C1 ile C3 arası mesafe
    const b = r2 + r3; // C2 ile C3 arası mesafe
    const c = dist; // C1 ile C2 arası mesafe

    // Kosinüs Teoremi ile açı bulma veya Heron formülü türevi ile yükseklik bulma.
    // X eksenindeki izdüşüm (Projection):
    // x = (a^2 - b^2 + c^2) / (2c)
    const proj = (a * a - b * b + c * c) / (2 * c);

    // Yüksekliği (h) Pisagor'dan bulalım: h = sqrt(a^2 - proj^2)
    const h = Math.sqrt(Math.max(0, a * a - proj * proj));

    // Şimdi bu lokal koordinatları global koordinatlara çevirelim.
    // Vektör matematiği: C1'den C2'ye giden birim vektör.
    const ux = dx / c;
    const uz = dz / c;

    // Normal vektör (Dikme)
    const nx = -uz;
    const nz = ux;

    // Sonuç Koordinat
    return {
      x: c1.x + ux * proj + nx * h,
      z: c1.z + uz * proj + nz * h,
    };
  }
}
