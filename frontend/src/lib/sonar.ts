// Sonar (page Réseau local) : placement des appareils sur la coupole, et libellés. Pur, sans three.js.
//
// Constantes reprises TELLES QUELLES de assets/3d/build_sonar.py (contrat Blender ↔ web).
// Repère three : x = r cos φ, z = r sin φ ; φ = π/2 face à la caméra.

import type { DeviceKind, NetDevice, RiskLevel } from "./api";

export const SONAR = {
  GROUND_TOP: 0.11,
  R_MIN: 0.72,
  OUTER_R: 3.05,
  RING_TRUSTED: 1.2,
  RING_KNOWN: 1.95,
  RING_NEW: 2.7,
  DOME_R: 3.2,
  DOME_H: 1.55,
  GLYPH_SIZE: 0.48,
  SECTORS: ["computer", "mobile", "home", "iot", "unknown"] as const,
};
export type Sector = (typeof SONAR.SECTORS)[number];

const STEP = (2 * Math.PI) / SONAR.SECTORS.length;
const START = Math.PI / 2 - 4.5 * STEP; // « unknown » (indice 4) centré face à la caméra

export const SECTOR_LABEL: Record<Sector, string> = {
  computer: "Ordinateurs",
  mobile: "Téléphones",
  home: "Maison",
  iot: "Objets connectés",
  unknown: "Inconnus",
};

const SECTOR_OF: Record<DeviceKind, Sector> = {
  gateway: "unknown", // la box est au centre ; un usurpateur, lui, est classé par son propre type
  computer: "computer",
  nas: "computer",
  mobile: "mobile",
  printer: "home",
  camera: "home",
  media: "home",
  iot: "iot",
  unknown: "unknown",
};

export const RISK_RANK: Record<RiskLevel, number> = { info: 0, low: 1, medium: 2, high: 3, critical: 4 };
export const RISK_LABEL: Record<RiskLevel, string> = { info: "Aucun", low: "Faible", medium: "Moyen", high: "Élevé", critical: "Critique" };
export const RISK_TONE: Record<RiskLevel, string> = { info: "muted", low: "muted", medium: "accent", high: "warn", critical: "critical" };
export const STATUS_LABEL: Record<NetDevice["status"], string> = { new: "Nouveau", baseline: "Connu", approved: "Approuvé" };
export const STATUS_TONE: Record<NetDevice["status"], string> = { new: "warn", baseline: "muted", approved: "accent" };

/** Hors de la table ARP depuis plus longtemps : affiché atténué (éteint ou parti). */
export const ABSENT_AFTER_MS = 15 * 60_000;

export function sectorIndex(sector: Sector): number {
  return SONAR.SECTORS.indexOf(sector);
}

/** Angle three du centre d'un secteur. */
export function sectorAngle(i: number): number {
  return START + STEP * (i + 0.5);
}

/** Hauteur de la coupole (demi-ellipsoïde) au rayon r. */
export function domeY(r: number): number {
  return SONAR.GROUND_TOP + SONAR.DOME_H * Math.sqrt(Math.max(0, 1 - (r / SONAR.DOME_R) ** 2));
}

export function ringFor(d: NetDevice): number {
  if (d.gateway_mismatch || d.status === "new") return SONAR.RING_NEW; // « à la porte »
  return d.status === "approved" ? SONAR.RING_TRUSTED : SONAR.RING_KNOWN;
}

export function displayName(d: NetDevice): string {
  return d.label ?? d.hostname?.split(".")[0] ?? d.vendor ?? d.ip;
}

export function isPresent(d: NetDevice, now: number): boolean {
  return now - new Date(d.last_seen).getTime() < ABSENT_AFTER_MS;
}

export interface SonarNode {
  d: NetDevice;
  sector: number;
  angle: number;
  radius: number;
  x: number;
  z: number;
  /** Hauteur du socle de la silhouette (mât = exposition), plafonnée sous la coupole. */
  lift: number;
}

const _EXPOSURE: Record<RiskLevel, number> = { info: 0, low: 0.08, medium: 0.22, high: 0.42, critical: 0.6 };

/** Hauteur du mât : risque des ports ouverts + leur nombre, jamais au-dessus de la coupole. */
export function liftFor(d: NetDevice, radius: number): number {
  const wanted = _EXPOSURE[d.risk] + 0.04 * Math.min(d.open_ports, 5);
  const ceiling = domeY(radius) - SONAR.GLYPH_SIZE - 0.05 - SONAR.GROUND_TOP; // contrat de build_sonar.py
  return Math.max(0, Math.min(wanted, ceiling));
}

/**
 * Place les appareils (sauf la box de référence, qui est la pièce centrale) : secteur = type,
 * anneau = confiance, répartis régulièrement dans leur secteur par ordre d'identifiant (stable
 * d'un rafraîchissement à l'autre tant que l'inventaire ne change pas).
 */
export function layoutSonar(devices: NetDevice[]): SonarNode[] {
  const groups = new Map<string, NetDevice[]>();
  for (const d of devices) {
    if (d.is_gateway) continue;
    const sector = sectorIndex(d.gateway_mismatch ? "unknown" : SECTOR_OF[d.kind]);
    const key = `${sector}:${ringFor(d)}`;
    groups.set(key, [...(groups.get(key) ?? []), d]);
  }
  const nodes: SonarNode[] = [];
  for (const [key, group] of groups) {
    const [sector, radius] = key.split(":").map(Number);
    group.sort((a, b) => a.id.localeCompare(b.id));
    const usable = STEP * 0.8; // marge aux frontières du secteur
    group.forEach((d, k) => {
      const offset = group.length === 1 ? 0 : -usable / 2 + (usable * k) / (group.length - 1);
      // Anneaux chargés : alternance de part et d'autre de l'anneau pour éviter les chevauchements.
      const r = radius + (group.length > 4 ? (k % 2 ? 0.14 : -0.14) : 0);
      const angle = sectorAngle(sector) + offset;
      nodes.push({ d, sector, angle, radius: r, x: Math.cos(angle) * r, z: Math.sin(angle) * r, lift: liftFor(d, r) });
    });
  }
  return nodes;
}
