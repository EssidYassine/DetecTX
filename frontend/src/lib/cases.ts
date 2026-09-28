// Page Alertes : dossiers (alertes regroupées par règle), radar des menaces. Sans three.js.

import type { AlertCase, AlertStatus } from "@/lib/api";
import { laneOf, TACTICS } from "@/lib/mitre";

export type Severity = AlertCase["severity"];

export const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];
export const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critique", high: "Haute", medium: "Moyenne", low: "Faible" };
/** Couleur de sévérité : nom de variable CSS (le rouge reste réservé au critique). */
export const SEVERITY_TONE: Record<Severity, string> = { critical: "critical", high: "warn", medium: "accent", low: "muted" };
export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export const openCount = (c: Pick<AlertCase, "by_status">) => c.by_status.new + c.by_status.ack;
export const isOpen = (c: Pick<AlertCase, "by_status">) => openCount(c) > 0;

/** Statut dominant d'un dossier : ce qui reste à faire en premier. */
export function caseStatus(c: Pick<AlertCase, "by_status">): AlertStatus {
  return c.by_status.new > 0 ? "new" : c.by_status.ack > 0 ? "ack" : "closed";
}

// ─────────────────────────────── radar (repris de assets/3d/build_radar.py)
export const RADAR = {
  GROUND_TOP: 0.11,
  R_MIN: 0.62,
  OUTER_R: 3.0,
  RING_R: [1.2, 1.8, 2.4, 3.0] as const,
  RING_LABEL: ["1 h", "24 h", "7 j", "30 j"] as const,
  SECTORS: 15,
  START: Math.PI / 2,
};
const STEP = (2 * Math.PI) / RADAR.SECTORS;
const HOUR = 3_600_000;
// Ancienneté -> rayon : interpolation logarithmique entre les anneaux.
const AGE_ANCHORS: [number, number][] = [
  [HOUR / 60, RADAR.R_MIN + 0.18], // < 1 min : au pied du poste
  [HOUR, RADAR.RING_R[0]],
  [24 * HOUR, RADAR.RING_R[1]],
  [7 * 24 * HOUR, RADAR.RING_R[2]],
  [30 * 24 * HOUR, RADAR.RING_R[3] - 0.08],
];

/** Angle (repère three : x = cos, z = sin) du centre d'un secteur. */
export function sectorAngle(sector: number): number {
  return RADAR.START + STEP * (sector + 0.5);
}

export function ageRadius(ageMs: number): number {
  const age = Math.max(ageMs, AGE_ANCHORS[0][0]);
  for (let k = 1; k < AGE_ANCHORS.length; k++) {
    const [a1, r1] = AGE_ANCHORS[k];
    if (age <= a1) {
      const [a0, r0] = AGE_ANCHORS[k - 1];
      return r0 + ((r1 - r0) * Math.log(age / a0)) / Math.log(a1 / a0);
    }
  }
  return AGE_ANCHORS[AGE_ANCHORS.length - 1][1]; // au-delà de 30 j : bord du radar
}

export interface RadarNode {
  c: AlertCase;
  sector: number;
  angle: number;
  radius: number;
  x: number;
  z: number;
  height: number; // hauteur du cristal (risque)
}

/** Place chaque dossier : secteur = tactique, distance = ancienneté de la dernière occurrence,
 *  hauteur = risque. Dans un secteur, les dossiers s'écartent en alternance autour de l'axe. */
export function radarLayout(cases: AlertCase[], now: number): RadarNode[] {
  const perSector = new Map<number, number>();
  return cases.map((c) => {
    const sector = laneOf(c.tactic);
    const k = perSector.get(sector) ?? 0;
    perSector.set(sector, k + 1);
    const slot = Math.ceil(k / 2) * (k % 2 === 1 ? 1 : -1); // 0, +1, -1, +2…
    const angle = sectorAngle(sector) + Math.max(-0.4, Math.min(0.4, slot * 0.2)) * STEP; // reste dans son secteur
    const radius = ageRadius(now - new Date(c.last_seen).getTime());
    return {
      c,
      sector,
      angle,
      radius,
      x: Math.cos(angle) * radius,
      z: Math.sin(angle) * radius,
      height: 0.25 + (Math.min(100, Math.max(0, c.risk)) / 100) * 0.85,
    };
  });
}

/** Tactiques des dossiers ouverts dans l'ordre de leur PREMIÈRE apparition : le récit de l'attaque. */
export function attackSequence(cases: AlertCase[]): { tactic: number; at: string }[] {
  const first = new Map<number, string>();
  for (const c of cases) {
    if (!isOpen(c) || !c.tactic) continue;
    const lane = laneOf(c.tactic);
    const prev = first.get(lane);
    if (!prev || c.first_seen < prev) first.set(lane, c.first_seen);
  }
  return [...first.entries()].map(([tactic, at]) => ({ tactic, at })).sort((a, b) => a.at.localeCompare(b.at));
}

export function tacticLabel(tactic: string | null): string {
  return TACTICS[laneOf(tactic)].label;
}

export function fmtDuration(minutes: number): string {
  if (minutes < 1) return "< 1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 1440)} j`;
}

export function fmtWhen(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
