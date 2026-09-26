// Score de posture de sécurité (0-100) dérivé des alertes par sévérité.

export type PostureTone = "ok" | "warn" | "critical";

export function postureScore(sev: Record<string, number>): number {
  const penalty = (sev.critical ?? 0) * 8 + (sev.high ?? 0) * 2 + (sev.medium ?? 0) * 0.5;
  return Math.max(0, Math.round(100 - penalty));
}

export const postureTone = (s: number): PostureTone => (s >= 70 ? "ok" : s >= 40 ? "warn" : "critical");

export const postureLabel = (s: number): string =>
  s >= 70 ? "sous contrôle" : s >= 40 ? "à surveiller" : "action requise";
