// Page Événements : journaux affichés, libellés, formats. Sans dépendance three.js.

export interface Lane {
  channel: string;
  label: string;
  short: string;
}

/** Ordre des couloirs du relief, de l'avant vers l'arrière (volumes faibles devant). */
export const LANES: Lane[] = [
  { channel: "Security", label: "Sécurité", short: "Sécurité" },
  { channel: "Microsoft-Windows-PowerShell/Operational", label: "PowerShell", short: "PowerShell" },
  { channel: "DeTecTX-FileMonitor", label: "Fichiers surveillés", short: "Fichiers" },
  { channel: "Application", label: "Applications", short: "Applis" },
  { channel: "System", label: "Système", short: "Système" },
  { channel: "Microsoft-Windows-Sysmon/Operational", label: "Sysmon", short: "Sysmon" },
];

const LABELS = new Map(LANES.map((l) => [l.channel, l.short]));

export function channelLabel(channel: string): string {
  return LABELS.get(channel) ?? channel.replace(/^Microsoft-Windows-/, "").replace(/\/Operational$/, "");
}

export const PERIODS = [
  { key: "24h", label: "24 h", hours: 24 },
  { key: "48h", label: "48 h", hours: 48 },
  { key: "7d", label: "7 j", hours: 168 },
] as const;
export type PeriodKey = (typeof PERIODS)[number]["key"];

export const LIST_WINDOWS = [
  { key: "1d", label: "24 h", minutes: 60 * 24 },
  { key: "7d", label: "7 jours", minutes: 60 * 24 * 7 },
  { key: "30d", label: "30 jours", minutes: 60 * 24 * 30 },
  { key: "all", label: "Tout", minutes: undefined },
] as const;
export type ListWindow = (typeof LIST_WINDOWS)[number]["key"];

export const INTEREST_LABEL: Record<string, string> = { info: "information", low: "faible", medium: "moyen", high: "élevé" };
export const INTEREST_TONE: Record<string, string> = { info: "muted", low: "accent", medium: "warn", high: "critical" };

/** Tranche horaire [début, fin) d'un indice de l'histogramme. */
export function binWindow(start: string, bin: number): { since: string; until: string } {
  const from = new Date(start).getTime() + bin * 3_600_000;
  return { since: new Date(from).toISOString(), until: new Date(from + 3_600_000).toISOString() };
}

export function fmtHourRange(start: string, bin: number): string {
  const { since, until } = binWindow(start, bin);
  const a = new Date(since);
  const b = new Date(until);
  const day = a.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
  const hh = (d: Date) => d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return `${day} · ${hh(a)}–${hh(b)}`;
}

export function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}
