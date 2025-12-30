// src/core/solvers/coil-solver/spine.ts

import { HoneycombMath } from '../../math/cylinder-math/honeycomb';

/**
 * Bal peteği yapısındaki potansiyel yuvaları (Pockets) temsil eder.
 */
export interface NestCandidate {
  position: { x: number; z: number }; // Yuvanın merkez noktası
  supportingCoils: [string, string]; // Alttaki iki rulonun ID'si (Destekçiler)
  maxRadius: number; // Bu yuvaya sığabilecek maksimum yarıçap
}

/**
 * Yerleşmiş bir rulonun verisi (Sadece hesaplama için basitleştirilmiş)
 */
export interface SpineNode {
  id: string;
  x: number;
  z: number;
  radius: number;
}

export class HoneycombSpine {
  private nodes: SpineNode[] = [];
  private containerWidth: number;
  private containerHeight: number;

  constructor(containerWidth: number, containerHeight: number) {
    this.containerWidth = containerWidth;
    this.containerHeight = containerHeight;
  }

  /**
   * Yeni bir rulo eklendiğinde omurgayı günceller.
   */
  public addNode(node: SpineNode) {
    this.nodes.push(node);
  }

  /**
   * Mevcut duruma göre olası tüm "Bal Peteği Yuvalarını" hesaplar.
   * Bu fonksiyon ileri matematik kullanır:
   * Mevcut tüm rulo çiftlerini tarar ve aralarına yeni rulo girip girmeyeceğine bakar.
   */
  public findCandidates(radiusToCheck: number): NestCandidate[] {
    const candidates: NestCandidate[] = [];

    // Tüm ikili kombinasyonları kontrol et (Brute-force optimization)
    // Not: Gerçek hayatta sadece "yakın" olanlara bakılır ama 1000 rulo için bu işlem mikrosaniyeler sürer.
    for (let i = 0; i < this.nodes.length; i++) {
      for (let j = i + 1; j < this.nodes.length; j++) {
        const c1 = this.nodes[i];
        const c2 = this.nodes[j];

        // 1. Yükseklik Farkı Kontrolü: Çok farklı katmanlardaki rulolar yuva oluşturmaz.
        // Sadece birbirine yakın yükseklikteki (Z ekseni) rulolara bak.
        // (Burada Z bizim yükseklik eksenimiz)
        if (Math.abs(c1.z - c2.z) > (c1.radius + c2.radius) * 1.5) continue;

        // 2. Matematiksel Yuva Hesabı
        const nestPos = HoneycombMath.calculateNestPosition(
          { x: c1.x, z: c1.z },
          c1.radius,
          { x: c2.x, z: c2.z },
          c2.radius,
          radiusToCheck
        );

        if (nestPos) {
          // 3. Sınır Kontrolü (Duvarlara çarpıyor mu?)
          if (nestPos.x - radiusToCheck < 0) continue; // Sol duvar
          if (nestPos.x + radiusToCheck > this.containerWidth) continue; // Sağ duvar
          if (nestPos.z + radiusToCheck * 2 > this.containerHeight) continue; // Tavan

          // 4. Çakışma Kontrolü (Collision Check)
          // Hesaplanan yuva boş mu? Yoksa orada zaten başka bir rulo var mı?
          if (!this.isOverlappingAny(nestPos.x, nestPos.z, radiusToCheck)) {
            candidates.push({
              position: nestPos,
              supportingCoils: [c1.id, c2.id],
              maxRadius: radiusToCheck, // Şimdilik aranan çapı veriyoruz
            });
          }
        }
      }
    }

    // Adayları yüksekliğe göre sırala (En aşağıdakini önce doldurmak iyidir)
    return candidates.sort((a, b) => a.position.z - b.position.z);
  }

  /**
   * Bir noktanın herhangi bir mevcut rulo ile çakışıp çakışmadığını kontrol eder.
   */
  private isOverlappingAny(x: number, z: number, radius: number): boolean {
    const SAFETY_MARGIN = 0.1; // 1mm tolerans

    for (const node of this.nodes) {
      const dx = x - node.x;
      const dz = z - node.z;
      const dist = Math.sqrt(dx * dx + dz * dz);

      // Eğer mesafe yarıçaplar toplamından küçükse, iç içe girmişlerdir.
      if (dist < node.radius + radius - SAFETY_MARGIN) {
        return true;
      }
    }
    return false;
  }
}
