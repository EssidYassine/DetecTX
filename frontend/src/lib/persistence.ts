// Persistance : libellés, confiance et disposition des « Racines » (vue Système › Persistance).

import type { PersistenceEntry, PersistenceMechanism, PersistenceScope, Signature } from "./api";

export const MECHANISMS: { id: PersistenceMechanism; label: string; short: string; how: string }[] = [
  { id: "run", label: "Clés Run", short: "Run", how: "Registre : programmes lancés à l'ouverture de session." },
  { id: "startup", label: "Dossier Démarrage", short: "Démarrage", how: "Raccourcis du dossier Démarrage (utilisateur et commun)." },
  { id: "task", label: "Tâches planifiées", short: "Tâches", how: "Tâches déclenchées au démarrage, à la connexion ou à heure fixe." },
  { id: "service", label: "Services", short: "Services", how: "Services à démarrage automatique ou en cours d'exécution." },
  { id: "driver", label: "Pilotes", short: "Pilotes", how: "Pilotes chargés dans le noyau." },
  { id: "wmi", label: "Abonnements WMI", short: "WMI", how: "Abonnements d'événements WMI permanents (technique furtive)." },
];
export const MECHANISM_INDEX: Record<PersistenceMechanism, number> = { run: 0, startup: 1, task: 2, service: 3, driver: 4, wmi: 5 };
export const MECHANISM_LABEL: Record<PersistenceMechanism, string> = Object.fromEntries(MECHANISMS.map((m) => [m.id, m.label])) as Record<PersistenceMechanism, string>;

export const SCOPE_LABEL: Record<PersistenceScope, string> = {
  user: "utilisateur",
  machine: "machine (élevé)",
  system: "SYSTEM",
  kernel: "noyau",
};

export type Trust = "new" | "risky" | "signed" | "microsoft" | "unknown";

export const TRUST_LABEL: Record<Trust, string> = {
  new: "Nouveau ou modifié",
  risky: "Non signé",
  signed: "Éditeur signé",
  microsoft: "Microsoft",
  unknown: "Non vérifiable",
};
export const TRUST_TONE: Record<Trust, "critical" | "warn" | "accent" | "muted"> = {
  new: "critical",
  risky: "warn",
  signed: "accent",
  microsoft: "muted", // en 3D : teinte sable (voir roots.tsx)
  unknown: "muted",
};

export function trust(e: PersistenceEntry): Trust {
  const v = e.signature?.verdict;
  if (e.status !== "baseline" && v !== "microsoft") return "new";
  if (v === "unsigned" || v === "invalid") return "risky";
  if (v === "signed") return "signed";
  if (v === "microsoft") return "microsoft";
  return "unknown";
}

export function signatureText(sig: Signature | null | undefined, target?: string | null): string {
  if (!target) return "aucun fichier à vérifier";
  if (!sig) return "vérification en cours…";
  switch (sig.verdict) {
    case "microsoft":
      return `Microsoft (${sig.publisher ?? "signé"})${sig.via_catalog ? " · catalogue" : ""}`;
    case "signed":
      return `${sig.publisher ?? "éditeur signé"}${sig.detail ? ` · ${sig.detail}` : ""}`;
    case "unsigned":
      return "non signé";
    case "invalid":
      return `signature invalide${sig.detail ? ` (${sig.detail})` : ""}`;
    default:
      return sig.detail ?? "non vérifiable";
  }
}

// ─────────────────────────────── géométrie des racines (reprise de assets/3d/build_roots.py)
export const ROOT_DEPTH = 3.3;
const TOPS = [-0.75, -0.45, -0.15, 0.15, 0.45, 0.75];
const TIPS: [number, number][] = [
  [-2.85, 0.25],
  [-1.75, -0.2],
  [-0.62, 0.3],
  [0.62, -0.25],
  [1.75, 0.2],
  [2.85, -0.15],
];
/** Profondeur (glTF, y vers le haut) des limites des strates : utilisateur | machine & SYSTEM | noyau. */
export const STRATA_Y = [0, -1.1, -2.2, -3.3];

type V3 = [number, number, number];

/** Points de contrôle Bézier de la racine i, convertis Blender (Z haut) → glTF (Y haut). */
function controls(i: number): V3[] {
  const sx = TOPS[i];
  const [tx, ty] = TIPS[i];
  const blender: V3[] = [
    [sx, 0, 0],
    [sx * 1.05, 0, -ROOT_DEPTH / 3],
    [tx * 0.9, ty * 0.6, (-2 * ROOT_DEPTH) / 3],
    [tx, ty, -ROOT_DEPTH],
  ];
  return blender.map(([x, y, z]) => [x, z, -y]);
}

export function rootPoint(i: number, t: number): V3 {
  const p = controls(i);
  const u = 1 - t;
  const w = [u * u * u, 3 * u * u * t, 3 * u * t * t, t * t * t];
  return [0, 1, 2].map((k) => w[0] * p[0][k] + w[1] * p[1][k] + w[2] * p[2][k] + w[3] * p[3][k]) as V3;
}

export function rootTip(i: number): V3 {
  return rootPoint(i, 1);
}

/** Portion de racine (paramètre t) où se placent les entrées selon leurs privilèges. */
const BAND: Record<PersistenceScope, [number, number]> = {
  user: [0.07, 0.31],
  machine: [0.37, 0.5],
  system: [0.5, 0.64],
  kernel: [0.7, 0.96],
};

/** Nombre pseudo-aléatoire stable (0..1) tiré d'une chaîne. */
export function seed(text: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

export interface Nodule {
  entry: PersistenceEntry;
  trust: Trust;
  root: number;
  position: V3;
  size: number;
}

/**
 * Chaque entrée devient un nodule le long de SA racine, à la profondeur de ses privilèges,
 * réparti en grappe autour du tronc. Position stable (tirée de l'id) : rien ne saute d'un relevé à l'autre.
 */
export function noduleLayout(entries: PersistenceEntry[]): Nodule[] {
  const groups = new Map<string, PersistenceEntry[]>();
  for (const e of entries) {
    const key = `${e.mechanism}|${e.scope}`;
    const list = groups.get(key) ?? [];
    list.push(e);
    groups.set(key, list);
  }
  const out: Nodule[] = [];
  groups.forEach((list) => {
    list.sort((a, b) => a.id.localeCompare(b.id));
    list.forEach((e, k) => {
      const root = MECHANISM_INDEX[e.mechanism];
      const [t0, t1] = BAND[e.scope];
      const t = t0 + ((k + 0.5) / list.length) * (t1 - t0) + (seed(e.id, 3) - 0.5) * 0.02;
      const [x, y, z] = rootPoint(root, t);
      const tr = trust(e);
      const size = tr === "new" ? 0.07 : tr === "risky" ? 0.055 : tr === "signed" ? 0.042 : 0.026;
      const trunk = 0.1 - 0.08 * t; // rayon de la racine à cet endroit (effilée)
      const spread = trunk + size + seed(e.id, 1) * Math.min(0.24, 0.03 + list.length * 0.0012);
      const a = seed(e.id, 2) * Math.PI * 2;
      out.push({ entry: e, trust: tr, root, position: [x + Math.cos(a) * spread, y + (seed(e.id, 4) - 0.5) * 0.05, z + Math.sin(a) * spread], size });
    });
  });
  return out;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}
