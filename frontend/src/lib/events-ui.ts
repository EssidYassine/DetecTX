// Page Événements : journaux, thèmes, libellés, formats. Sans dépendance three.js.

export interface Source {
  channel: string;
  label: string;
}

/** Journaux proposés dans le filtre (même liste que la santé de la collecte côté backend). */
export const SOURCES: Source[] = [
  { channel: "Security", label: "Sécurité" },
  { channel: "Microsoft-Windows-TerminalServices-LocalSessionManager/Operational", label: "Sessions" },
  { channel: "Microsoft-Windows-Windows Defender/Operational", label: "Defender" },
  { channel: "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall", label: "Pare-feu" },
  { channel: "Microsoft-Windows-CodeIntegrity/Operational", label: "Intégrité du code" },
  { channel: "Microsoft-Windows-PowerShell/Operational", label: "PowerShell (scripts)" },
  { channel: "Windows PowerShell", label: "PowerShell (sessions)" },
  { channel: "Microsoft-Windows-Sysmon/Operational", label: "Sysmon" },
  { channel: "Microsoft-Windows-WMI-Activity/Operational", label: "WMI" },
  { channel: "Microsoft-Windows-TaskScheduler/Operational", label: "Tâches planifiées" },
  { channel: "Microsoft-Windows-WLAN-AutoConfig/Operational", label: "Wi-Fi" },
  { channel: "Microsoft-Windows-NetworkProfile/Operational", label: "Réseaux" },
  { channel: "Microsoft-Windows-Kernel-PnP/Configuration", label: "Périphériques" },
  { channel: "Microsoft-Windows-Bits-Client/Operational", label: "Transferts BITS" },
  { channel: "System", label: "Système" },
  { channel: "Application", label: "Applications" },
  { channel: "DeTecTX-FileMonitor", label: "Fichiers surveillés" },
  { channel: "DeTecTX-LogFile", label: "Fichiers .log" },
];

const LABELS = new Map(SOURCES.map((s) => [s.channel, s.label]));

export function channelLabel(channel: string): string {
  return LABELS.get(channel) ?? channel.replace(/^Microsoft-Windows-/, "").replace(/\/Operational$/, "");
}

/** Thèmes du relief et du fil (mêmes clés que le backend : event_catalog.THEMES). */
export const THEMES: Record<string, { label: string; icon: ThemeIcon }> = {
  sessions: { label: "Sessions & comptes", icon: "user" },
  defense: { label: "Défense", icon: "shield" },
  execution: { label: "Exécution", icon: "terminal" },
  network: { label: "Réseau & périphériques", icon: "wifi" },
  system: { label: "Système", icon: "chip" },
  apps: { label: "Applications & fichiers", icon: "window" },
};
export type ThemeIcon = "user" | "shield" | "terminal" | "wifi" | "chip" | "window";

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
