// Page MITRE : tactiques (ATT&CK v19), simulateur de couverture, disposition de la ruche. Sans three.js.

import type { MitreCoverage, TechniqueCoverage } from "@/lib/api";

/** Libellés français des 15 tactiques ATT&CK (v19 : « Defense Evasion » scindée en deux). */
export const TACTIC_FR: Record<string, string> = {
  reconnaissance: "Reconnaissance",
  "resource-development": "Ressources",
  "initial-access": "Accès initial",
  execution: "Exécution",
  persistence: "Persistance",
  "privilege-escalation": "Élévation de privilèges",
  stealth: "Furtivité",
  "defense-impairment": "Neutralisation des défenses",
  "credential-access": "Identifiants",
  discovery: "Découverte",
  "lateral-movement": "Déplacement latéral",
  collection: "Collecte",
  "command-and-control": "Commande & contrôle",
  exfiltration: "Exfiltration",
  impact: "Impact",
};

export const tacticLabel = (id: string) => TACTIC_FR[id] ?? id;

/** Libellés courts (étiquettes 3D de la ruche, où la place manque). */
const TACTIC_SHORT: Record<string, string> = {
  reconnaissance: "Recon",
  "resource-development": "Ressources",
  "initial-access": "Accès init.",
  "privilege-escalation": "Privilèges",
  "defense-impairment": "Neutralisation",
  "lateral-movement": "Latéral",
  "command-and-control": "C2",
};
export const tacticShort = (id: string) => TACTIC_SHORT[id] ?? tacticLabel(id);

/** Règles actives pour une technique si l'on ajoutait `extra` aux sources collectées. */
export function effectiveWith(t: TechniqueCoverage, sources: ReadonlySet<string>): number {
  return Object.entries(t.by_source).reduce((sum, [src, n]) => sum + (src === "any" || sources.has(src) ? n : 0), 0);
}

export interface Simulation {
  sources: ReadonlySet<string>; // sources collectées + ajoutées par le simulateur
  techniques: number; // techniques avec au moins une règle active
  rules: number; // règles actives (chaque règle dépend d'une seule source : somme exacte)
}

export function simulate(cov: MitreCoverage, extra: ReadonlySet<string>): Simulation {
  const sources = new Set([...cov.sources.filter((s) => s.available).map((s) => s.id), ...extra]);
  return {
    sources,
    techniques: cov.techniques.filter((t) => effectiveWith(t, sources) > 0).length,
    rules: cov.totals.rules_effective + cov.plan.filter((p) => extra.has(p.source)).reduce((sum, p) => sum + p.rules, 0),
  };
}

// ─────────────────────────────── ruche (repris de assets/3d/build_hive.py)
export const HIVE = { GROUND_TOP: 0.11, PAD_TOP: 0.14, PAD_R: 1.48, COLS: 5, ROWS: 3, DX: 3.4, DZ: 3.1 };

/** Centre du quartier d'une tactique (serpentin : lignes alternées). */
export function padCenter(i: number): [number, number] {
  const row = Math.floor(i / HIVE.COLS);
  let col = i % HIVE.COLS;
  if (row % 2 === 1) col = HIVE.COLS - 1 - col;
  return [(col - (HIVE.COLS - 1) / 2) * HIVE.DX, (row - (HIVE.ROWS - 1) / 2) * HIVE.DZ];
}

// Voisins en coordonnées axiales (hexagones « pointe en haut »).
const DIRS: [number, number][] = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];

/** Coordonnées axiales en spirale depuis le centre : 1, puis anneaux de 6, 12, 18… */
export function spiral(count: number): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  for (let k = 1; out.length < count; k++) {
    let q = DIRS[4][0] * k;
    let r = DIRS[4][1] * k;
    for (let side = 0; side < 6 && out.length < count; side++) {
      for (let step = 0; step < k && out.length < count; step++) {
        out.push([q, r]);
        q += DIRS[side][0];
        r += DIRS[side][1];
      }
    }
  }
  return out.slice(0, count);
}

export interface Cell {
  t: TechniqueCoverage;
  district: number;
  x: number;
  z: number;
  size: number; // rayon de l'alvéole
}

/** Alvéoles : dans chaque quartier, les techniques les mieux couvertes au centre. */
export function hiveLayout(techniques: TechniqueCoverage[], tacticIds: string[]): Cell[] {
  const cells: Cell[] = [];
  tacticIds.forEach((tactic, district) => {
    const group = techniques
      .filter((t) => t.district === tactic)
      .sort((a, b) => b.effective - a.effective || b.theoretical - a.theoretical || b.alerts - a.alerts || a.id.localeCompare(b.id));
    if (!group.length) return;
    const rings = Math.max(1, Math.ceil((-3 + Math.sqrt(9 + 12 * (group.length - 1))) / 6)); // anneaux nécessaires
    const s = Math.min(0.17, (HIVE.PAD_R - 0.06) / (rings * Math.sqrt(3) + 1)); // pas d'alvéole
    const [cx, cz] = padCenter(district);
    spiral(group.length).forEach(([q, r], i) => {
      cells.push({ t: group[i], district, x: cx + s * Math.sqrt(3) * (q + r / 2), z: cz + s * 1.5 * r, size: s * 0.9 });
    });
  });
  return cells;
}
