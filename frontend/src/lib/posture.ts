// Posture du poste : vocabulaire partagé (le calcul est côté serveur : GET /stats/posture).

import type { FindingLevel, PillarKey, PostureTone as ServerTone } from "@/lib/api";

/** Ton utilisé par les scènes 3D (la posture « inconnue » s'affiche en vigilance). */
export type PostureTone = "ok" | "warn" | "critical";

export function sceneTone(tone: ServerTone | undefined): PostureTone {
  return tone === "ok" || tone === "critical" ? tone : "warn";
}

/** Variable CSS d'un ton (le rouge reste réservé au critique ; ok = accent). */
export const TONE_VAR: Record<ServerTone, string> = { ok: "accent", warn: "warn", critical: "critical", unknown: "muted" };
export const LEVEL_VAR: Record<FindingLevel, string> = { critical: "critical", high: "warn", medium: "warn", low: "accent", ok: "accent" };
export const LEVEL_LABEL: Record<FindingLevel, string> = { critical: "critique", high: "élevé", medium: "moyen", low: "faible", ok: "ok" };

/** Ordre des piliers = ordre des pétales du bouclier (Menaces face à la caméra). */
export const PILLAR_ORDER: PillarKey[] = ["threats", "exposure", "defense", "visibility", "health"];

/** Pictogrammes (SVG 16×16, trait 1,6 px). */
export const PILLAR_ICON: Record<PillarKey, string> = {
  threats: "M8 1.8 14 13H2L8 1.8ZM8 6v3.4M8 11.2h.01",
  exposure: "M2.5 8h11M8 2.5c1.6 1.5 2.4 3.3 2.4 5.5S9.6 12 8 13.5M8 2.5C6.4 4 5.6 5.8 5.6 8S6.4 12 8 13.5M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
  defense: "M8 1.8 13 3.6v4c0 3.1-2.1 5.5-5 6.6-2.9-1.1-5-3.5-5-6.6v-4L8 1.8ZM5.8 8l1.6 1.6L10.4 6.4",
  visibility: "M1.6 8S4 3.6 8 3.6 14.4 8 14.4 8 12 12.4 8 12.4 1.6 8 1.6 8ZM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  health: "M1.8 8.4h2.6l1.6-3.6 2.4 6.4 1.8-4.2 1 1.4h3",
};

/** Salutation selon l'heure locale (aucun prénom deviné depuis l'e-mail). */
export function greeting(date: Date): string {
  const h = date.getHours();
  return h >= 5 && h < 12 ? "Bonjour" : h >= 12 && h < 18 ? "Bon après-midi" : "Bonsoir";
}
