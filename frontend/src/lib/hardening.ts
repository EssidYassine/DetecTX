// Durcissement : ordre des thèmes, tons et libellés (vue Système › Durcissement).

import type { HardeningControl, HardeningSnapshot } from "./api";

export const THEME_ORDER = ["boot", "identity", "elevation", "network", "visibility", "accounts", "defense"];

export const GRADE_TONE: Record<HardeningSnapshot["summary"]["grade"], "accent" | "warn" | "critical"> = {
  A: "accent",
  B: "accent",
  C: "warn",
  D: "critical",
  E: "critical",
};

export const STATE_LABEL: Record<HardeningControl["state"], string> = {
  ok: "En place",
  weak: "À renforcer",
  na: "Sans objet",
  unknown: "Illisible",
};

export const LEVEL_LABEL: Record<HardeningControl["level"], string> = { high: "important", medium: "moyen", low: "faible" };

export function controlTone(c: HardeningControl): "accent" | "warn" | "critical" | "muted" {
  if (c.state === "ok") return "accent";
  if (c.state === "weak") return c.level === "high" ? "critical" : "warn";
  return "muted";
}

/** Contrôles faibles d'abord (les plus graves en tête), puis le reste par thème. */
export function sortControls(controls: HardeningControl[]): HardeningControl[] {
  const rank = (c: HardeningControl) => (c.state === "weak" ? { high: 0, medium: 1, low: 2 }[c.level] : c.state === "unknown" ? 3 : c.state === "ok" ? 4 : 5);
  return [...controls].sort((a, b) => rank(a) - rank(b) || THEME_ORDER.indexOf(a.theme) - THEME_ORDER.indexOf(b.theme));
}

/** Liens autorisés : écrans de Windows et page officielle Sysinternals (jamais une URL venue d'ailleurs). */
export function safeLink(uri: string): boolean {
  return /^(ms-settings:[a-z-]+|windowsdefender:\/\/[a-z]+|https:\/\/learn\.microsoft\.com\/)/.test(uri);
}
