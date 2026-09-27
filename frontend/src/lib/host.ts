// Formatage et logique partagés des métriques de l'hôte (page Système, bandeau héros de l'Overview).

export function fmtBytes(b: number): string {
  if (b < 1024) return `${Math.round(b)} o`;
  const u = ["Ko", "Mo", "Go", "To"];
  let i = -1;
  do {
    b /= 1024;
    i++;
  } while (b >= 1024 && i < u.length - 1);
  return `${b.toFixed(1)} ${u[i]}`;
}

export function fmtUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${d}j ${h}h ${m}m`;
}

/** Ton d'une charge en % — mêmes seuils que la jauge `Gauge` (charts.tsx). */
export type LoadTone = "accent" | "warn" | "critical";
export const loadTone = (v: number): LoadTone => (v >= 90 ? "critical" : v >= 70 ? "warn" : "accent");

/** Un cœur affiché : charge en % (null = emplacement inactif) et libellé pour l'infobulle. */
export interface CoreSlot {
  value: number | null;
  label: string;
}

/**
 * Projette les cœurs logiques réels sur `slots` cœurs visuels (la puce 3D en a 12).
 * Autant de cœurs : correspondance directe. Plus : moyenne par groupes contigus.
 * Moins : les emplacements en trop restent inactifs.
 */
export function mapCores(perCore: number[] | undefined, slots = 12): CoreSlot[] {
  const n = perCore?.length ?? 0;
  if (!perCore || n === 0) {
    return Array.from({ length: slots }, (_, i) => ({ value: null, label: `Cœur ${i + 1}` }));
  }
  if (n > slots) {
    return Array.from({ length: slots }, (_, i) => {
      const a = Math.floor((i * n) / slots);
      const b = Math.max(Math.floor(((i + 1) * n) / slots), a + 1);
      const group = perCore.slice(a, b);
      const avg = group.reduce((s, v) => s + v, 0) / group.length;
      return { value: avg, label: group.length > 1 ? `Cœurs ${a + 1}–${b}` : `Cœur ${a + 1}` };
    });
  }
  return Array.from({ length: slots }, (_, i) =>
    i < n ? { value: perCore[i], label: `Cœur ${i + 1}` } : { value: null, label: "Emplacement inactif" },
  );
}

/** Charge d'un processus en % de la machine entière (psutil donne un % d'UN cœur). */
export const machineLoad = (cpuPercent: number, cpuCount: number): number =>
  Math.min(100, cpuPercent / Math.max(1, cpuCount));
