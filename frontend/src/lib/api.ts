// Client API DeTecTX — parle au backend FastAPI.

export const API_URL =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

const TOKEN_KEY = "detectx_token";

/** Émis quand l'API répond 401 hors de /login (session expirée ou token invalide). */
export const SESSION_EXPIRED_EVENT = "detectx:session-expired";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export interface User {
  id: number;
  email: string;
  role: "admin" | "analyst" | "viewer";
  is_active: boolean;
  mfa_enabled: boolean;
  created_at: string;
}

async function readError(res: Response): Promise<string> {
  // Session expirée / token invalide : on nettoie et on renvoie vers la connexion
  // (sauf si on est déjà sur /login, où un 401 = simplement de mauvais identifiants).
  if (
    res.status === 401 &&
    typeof window !== "undefined" &&
    !window.location.pathname.startsWith("/login")
  ) {
    clearToken();
    // Module hors React : on prévient le layout, qui redirige via le routeur Next.
    window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
    return "Session expirée — reconnecte-toi.";
  }
  try {
    const data = await res.json();
    return typeof data.detail === "string" ? data.detail : "Erreur inattendue";
  } catch {
    return `Erreur ${res.status}`;
  }
}

export async function login(
  email: string,
  password: string,
  otp?: string,
): Promise<string> {
  const body = new URLSearchParams({ username: email, password });
  if (otp) body.set("otp", otp);

  const res = await fetch(`${API_URL}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(await readError(res));

  const data = (await res.json()) as { access_token: string };
  setToken(data.access_token);
  return data.access_token;
}

export async function register(email: string, password: string): Promise<User> {
  const res = await fetch(`${API_URL}/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as User;
}

function authHeaders(): HeadersInit {
  const token = getToken();
  if (!token) throw new Error("Non authentifié");
  return { Authorization: `Bearer ${token}` };
}

export async function fetchMe(): Promise<User> {
  const res = await fetch(`${API_URL}/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as User;
}

export interface EventItem {
  id: string;
  timestamp: string;
  /** Libellé de l'Event ID (catalogue DeTecTX), ex. « Nouveau service installé ». */
  title: string | null;
  /** Phrase lisible, ex. « Connecté au Wi-Fi « Maison » ». */
  summary: string | null;
  channel: string;
  event_id: number | null;
  provider: string | null;
  computer: string | null;
  level: string | null;
  record_id: number | null;
  message: string | null;
}

export interface EventKnowledge {
  title: string;
  what: string;
  why: string;
  level: "info" | "low" | "medium" | "high";
  attack: string | null;
}

export interface EventDetail extends EventItem {
  fields: Record<string, unknown>;
  knowledge: EventKnowledge | null;
  alerts: { id: number; rule_title: string; severity: string; status: string; created_at: string }[];
}

export interface EventHistogram {
  start: string; // début de la 1re tranche horaire (UTC)
  hours: number;
  lanes: { key: string; label: string }[]; // thèmes, de l'avant vers l'arrière du relief
  counts: Record<string, number[]>; // thème -> volume par heure
  alerts: { bin: number; lane: string; severity: string; count: number }[];
}

export interface FeedItem {
  id: string;
  timestamp: string;
  channel: string;
  theme: string;
  event_id: number | null;
  title: string | null;
  summary: string | null;
  level: "info" | "low" | "medium" | "high";
  /** Répétitions repliées (Windows journalise souvent un même changement plusieurs fois). */
  count: number;
}

export interface Hunt {
  id: string;
  title: string;
  question: string;
  channels: string[];
  event_ids: number[];
  keywords: string[];
  attack: string | null;
  level: string;
  requires: ("admin" | "sysmon")[];
  count: number;
}

export type ChannelStatus = "ok" | "quiet" | "stale" | "missing";

export interface CollectionHealth {
  status: "ok" | "degraded" | "down";
  summary: string;
  collectors: {
    kind: "integre" | "agent";
    label: string;
    computer: string;
    alive: boolean;
    last_seen: string;
    version: string | null;
    admin: boolean | null;
    interval_sec: number | null;
  }[];
  sysmon: { installed: boolean; running: boolean; service: string | null };
  channels: { channel: string; label: string; last_event: string | null; count_24h: number; status: ChannelStatus; hint: string | null }[];
  last_event: string | null;
}

export interface EventStats {
  total: number;
  last_24h: number;
  by_channel: Record<string, number>;
}

export interface EventPage {
  total: number;
  items: EventItem[];
}

export async function fetchEventStats(): Promise<EventStats> {
  const res = await fetch(`${API_URL}/events/stats`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as EventStats;
}

export async function fetchEvents(limit = 25): Promise<EventPage> {
  return searchEvents({ limit });
}

export async function searchEvents(params: {
  offset?: number;
  limit?: number;
  q?: string;
  channel?: string;
  eventId?: number;
  hunt?: string;
  theme?: string;
  minutes?: number;
  since?: string;
  until?: string;
}): Promise<EventPage> {
  const qs = new URLSearchParams();
  qs.set("offset", String(params.offset ?? 0));
  qs.set("limit", String(params.limit ?? 50));
  if (params.q) qs.set("q", params.q);
  if (params.channel) qs.set("channel", params.channel);
  if (params.eventId !== undefined) qs.set("event_id", String(params.eventId));
  if (params.hunt) qs.set("hunt", params.hunt);
  if (params.theme) qs.set("theme", params.theme);
  if (params.minutes) qs.set("minutes", String(params.minutes));
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);

  const res = await fetch(`${API_URL}/events?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as EventPage;
}

export async function fetchEventDetail(id: string): Promise<EventDetail> {
  const res = await fetch(`${API_URL}/events/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as EventDetail;
}

export async function fetchEventHistogram(hours = 48): Promise<EventHistogram> {
  const res = await fetch(`${API_URL}/events/histogram?hours=${hours}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as EventHistogram;
}

export async function fetchHunts(minutes = 60 * 24 * 7): Promise<Hunt[]> {
  const res = await fetch(`${API_URL}/events/hunts?minutes=${minutes}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Hunt[];
}

/** Fil de la machine : événements marquants récents, en phrases. */
export async function fetchFeed(minutes = 60 * 24, limit = 40): Promise<FeedItem[]> {
  const res = await fetch(`${API_URL}/events/feed?minutes=${minutes}&limit=${limit}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as FeedItem[];
}

export async function fetchCollectionHealth(): Promise<CollectionHealth> {
  const res = await fetch(`${API_URL}/events/health`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CollectionHealth;
}

export type AlertStatus = "new" | "ack" | "closed";
export type Resolution = "true_positive" | "false_positive" | "benign";

export interface Alert {
  id: number;
  rule_id: string;
  rule_title: string;
  severity: "critical" | "high" | "medium" | "low";
  risk_score: number;
  mitre: string | null;
  channel: string | null;
  event_id: number | null;
  event_timestamp: string | null;
  message: string | null;
  status: AlertStatus;
  created_at: string;
  resolution: Resolution | null;
  triaged_by: string | null;
  triaged_at: string | null;
}

export interface AlertPage {
  total: number;
  items: Alert[];
}

export interface AlertStats {
  total: number;
  by_severity: Record<string, number>;
  by_mitre: Record<string, number>;
  by_status: Partial<Record<AlertStatus, number>>;
}

export async function fetchAlerts(limit = 25): Promise<AlertPage> {
  return searchAlerts({ limit });
}

export async function searchAlerts(params: {
  offset?: number;
  limit?: number;
  severity?: string;
  mitre?: string;
  status?: AlertStatus | "open";
  since?: string; // ISO 8601, inclus
  until?: string; // ISO 8601, exclu
  q?: string;
  ruleId?: string;
}): Promise<AlertPage> {
  const qs = new URLSearchParams();
  qs.set("offset", String(params.offset ?? 0));
  qs.set("limit", String(params.limit ?? 25));
  if (params.severity && params.severity !== "all") qs.set("severity", params.severity);
  if (params.mitre) qs.set("mitre", params.mitre);
  if (params.status) qs.set("status", params.status);
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  if (params.q) qs.set("q", params.q);
  if (params.ruleId) qs.set("rule_id", params.ruleId);

  const res = await fetch(`${API_URL}/alerts?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AlertPage;
}

/** Dossier : toutes les alertes d'une même règle (5 × « Mimikatz » = 1 dossier ×5). */
export interface AlertCase {
  rule_id: string;
  rule_title: string;
  severity: Alert["severity"];
  risk: number;
  mitre: string | null;
  mitre_name: string | null;
  tactic: string | null; // identifiant ATT&CK ; null = technique hors base
  tactic_fr: string | null;
  count: number;
  by_status: Record<AlertStatus, number>;
  first_seen: string;
  last_seen: string;
  latest_id: number;
  latest_message: string | null;
  channels: string[];
}

export interface CaseSummary {
  open_alerts: number;
  open_cases: number;
  open_critical: number;
  tactics_hit: string[];
  closed: number;
  true_positive: number;
  false_positive: number;
  mean_triage_minutes: number | null;
}

export interface CasePage {
  total: number;
  cases: AlertCase[];
  summary: CaseSummary;
}

export async function fetchAlertCases(params: {
  status?: AlertStatus | "open";
  severity?: string;
  mitre?: string;
  since?: string;
  until?: string;
  q?: string;
}): Promise<CasePage> {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.severity && params.severity !== "all") qs.set("severity", params.severity);
  if (params.mitre) qs.set("mitre", params.mitre);
  if (params.since) qs.set("since", params.since);
  if (params.until) qs.set("until", params.until);
  if (params.q) qs.set("q", params.q);
  const res = await fetch(`${API_URL}/alerts/cases?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CasePage;
}

/** Triage d'un dossier entier (le serveur ne touche que les alertes dont le statut s'y prête). */
export async function triageCase(ruleId: string, input: TriageInput): Promise<{ updated: number; missing: number[] }> {
  const res = await fetch(`${API_URL}/alerts/cases/triage`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ rule_id: ruleId, ...input }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { updated: number; missing: number[] };
}

export interface TimelineDay {
  date: string; // AAAA-MM-JJ (jour local du navigateur)
  critical: number;
  high: number;
  medium: number;
  low: number;
}

/** Alertes par jour et par sévérité ; jours calculés dans le fuseau du navigateur. */
export async function fetchAlertTimeline(days = 30): Promise<TimelineDay[]> {
  const tz = -new Date().getTimezoneOffset(); // minutes à ajouter à UTC (UTC+2 -> 120)
  const res = await fetch(`${API_URL}/alerts/timeline?days=${days}&tz_offset=${tz}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return ((await res.json()) as { days: TimelineDay[] }).days;
}

export interface TriageInput {
  status: AlertStatus;
  resolution?: Resolution; // obligatoire pour « closed », interdite sinon (règle serveur)
}

export async function triageAlert(id: number, input: TriageInput): Promise<Alert> {
  const res = await fetch(`${API_URL}/alerts/${id}`, {
    method: "PATCH",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Alert;
}

export async function triageAlerts(ids: number[], input: TriageInput): Promise<{ updated: number; missing: number[] }> {
  const res = await fetch(`${API_URL}/alerts/triage`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ ids, ...input }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { updated: number; missing: number[] };
}

export async function fetchAlertStats(): Promise<AlertStats> {
  const res = await fetch(`${API_URL}/alerts/stats`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AlertStats;
}

export interface RuleInfo {
  id: string;
  title: string;
  severity: string;
  mitre: string | null;
  description: string | null;
}

export async function fetchDetectionRules(): Promise<RuleInfo[]> {
  const res = await fetch(`${API_URL}/detection/rules`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as RuleInfo[];
}

export interface CustomRule {
  id: number;
  rule_id: string;
  title: string;
  description: string | null;
  level: string;
  mitre: string | null;
  channel: string | null;
  event_id: number | null;
  keywords: string[];
  threshold_count: number | null;
  threshold_minutes: number | null;
  enabled: boolean;
  created_at: string;
  alerts: number; // alertes produites par la règle
}

export interface RuleInput {
  title: string;
  description?: string;
  level: string;
  mitre?: string;
  channel?: string;
  event_id?: number | null;
  keywords: string[];
  threshold_count?: number | null;
  threshold_minutes?: number | null;
}

export async function fetchCustomRules(): Promise<CustomRule[]> {
  const res = await fetch(`${API_URL}/rules`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CustomRule[];
}

/** Ce que la règle aurait trouvé (24 h / 7 j) avant de l'enregistrer. Lecture seule. */
export interface RulePreview {
  matches_24h: number;
  matches_7d: number;
  samples: EventItem[];
  noisy: boolean;
  would_alert: number;
}

export async function previewRule(input: RuleInput, signal?: AbortSignal): Promise<RulePreview> {
  const res = await fetch(`${API_URL}/rules/preview`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
    signal,
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as RulePreview;
}

export async function createRule(input: RuleInput): Promise<CustomRule> {
  const res = await fetch(`${API_URL}/rules`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CustomRule;
}

export async function toggleRule(id: number): Promise<CustomRule> {
  const res = await fetch(`${API_URL}/rules/${id}/toggle`, {
    method: "PATCH",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CustomRule;
}

export async function deleteRule(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/rules/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
}

export interface DiskInfo {
  mount: string;
  total: number;
  used: number;
  percent: number;
}
export interface Metrics {
  hostname?: string;
  cpu_percent: number;
  cpu_per_core?: number[];
  cpu_count: number;
  ram_percent: number;
  ram_used: number;
  ram_total: number;
  disks: DiskInfo[];
  net_up: number;
  net_down: number;
  uptime_seconds: number;
  process_count: number;
  timestamp: string;
}
export interface ProcInfo {
  pid: number;
  ppid: number | null;
  name: string | null;
  memory_percent: number;
  /** % d'UN cœur (psutil) : peut dépasser 100 sur une machine multi-cœurs. */
  cpu_percent: number;
  // Détails : null si l'OS refuse l'accès (processus système sans droits admin).
  rss: number | null;
  username: string | null;
  exe: string | null;
  status: string | null;
  started_at: string | null;
  /** Débit d'E/S (disque + réseau + périphériques), octets/s ; null hors Windows. */
  io_bps: number | null;
  threads: number | null;
  /** Fenêtres d'application (barre des tâches) possédées par CE processus ; null hors Windows. */
  windows: number | null;
}

export async function fetchMetrics(): Promise<Metrics> {
  const res = await fetch(`${API_URL}/metrics/current`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Metrics;
}

export async function fetchProcesses(limit = 40): Promise<ProcInfo[]> {
  const res = await fetch(`${API_URL}/metrics/processes?limit=${limit}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ProcInfo[];
}

export interface KillResult {
  killed: boolean;
  pid: number;
  name: string | null;
  tree: { pid: number; name: string | null }[];
  failed: { pid: number; name: string | null; reason: string }[];
}

/** Arrêt forcé (TerminateProcess). `tree` : ses sous-processus aussi. */
export async function killProcess(pid: number, options: { tree?: boolean } = {}): Promise<KillResult> {
  const qs = options.tree ? "?tree=true" : "";
  const res = await fetch(`${API_URL}/metrics/processes/${pid}/kill${qs}`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as KillResult;
}

export interface CloseResult {
  pid: number;
  name: string | null;
  windows: number;
  /** false : le programme n'a pas quitté (il demande sans doute d'enregistrer). */
  exited: boolean;
}

/** Fermeture propre : WM_CLOSE aux fenêtres du processus (comme la croix de la fenêtre). */
export async function closeProcess(pid: number): Promise<CloseResult> {
  const res = await fetch(`${API_URL}/metrics/processes/${pid}/close`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as CloseResult;
}

export type NetScope = "private" | "public" | "other";

export interface ListeningSocket {
  proto: "tcp" | "udp";
  ip: string;
  port: number;
  pid: number | null;
  process: string | null;
  /** Joignable depuis le réseau (toutes interfaces ou IP non loopback). */
  exposed: boolean;
}

export interface NetConnection {
  proto: "tcp" | "udp";
  lip: string;
  lport: number;
  rip: string;
  rport: number;
  status: string; // ESTABLISHED, TIME_WAIT, SYN_SENT…
  pid: number | null;
  process: string | null;
  scope: NetScope;
}

export interface NetSnapshot {
  listening: ListeningSocket[];
  connections: NetConnection[];
  truncated: number;
  loopback: number;
  timestamp: string;
}

export type RiskLevel = "info" | "low" | "medium" | "high" | "critical";
/** open : joignable depuis le réseau ; blocked : lié au réseau mais bloqué par le pare-feu. */
export type PortVerdict = "open" | "blocked" | "local" | "unknown";
export type PortScope = "any" | "local_subnet" | "restricted";

export interface FirewallRuleRef {
  name: string;
  action: "allow" | "block";
  profiles: string[];
  remote: string;
  by: "programme" | "service" | "port";
  group: string;
  interfaces: string[];
}

export interface PortExposure {
  proto: "tcp" | "udp";
  port: number;
  pid: number | null;
  process: string | null;
  exe: string | null;
  binds: string[];
  verdict: PortVerdict;
  scope: PortScope | null;
  reason: string;
  rules: FirewallRuleRef[];
  risk: { level: RiskLevel; service: string; why: string; attack: string; advice: string[] };
}

export interface ExposureSnapshot {
  available: boolean;
  error: string | null;
  profiles: {
    active: string[];
    states: Record<string, { enabled: boolean | null; default_inbound: "block" | "allow" | null; block_all: boolean | null }>;
  };
  networks: { name: string; category: string }[];
  rules_count: number;
  /** Blocages posés par DeTecTX (groupe dédié) : les seuls que l'interface peut retirer. */
  detectx_rules: { name: string; proto: "tcp" | "udp" | "any"; ports: number[]; profiles: string[] }[];
  /** Backend déjà administrateur : pas d'invite UAC. */
  elevated: boolean;
  ports: PortExposure[];
  summary: Record<PortVerdict | RiskLevel, number>;
  timestamp: string;
}

/** Ports en écoute croisés avec les règles du pare-feu Windows (lecture seule). */
export async function fetchExposure(): Promise<ExposureSnapshot> {
  const res = await fetch(`${API_URL}/metrics/exposure`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as ExposureSnapshot;
}

export type FirewallProfile = "domain" | "private" | "public";

/**
 * Bloque l'entrant sur des ports (règles du groupe DeTecTX). Windows affiche une invite UAC :
 * la requête reste en attente jusqu'à la réponse de l'utilisateur (2 min au plus).
 */
export async function blockPorts(targets: { proto: "tcp" | "udp"; port: number }[], profiles: FirewallProfile[]): Promise<{ ok: boolean; rules: string[] }> {
  const res = await fetch(`${API_URL}/metrics/firewall/block`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ targets, profiles }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { ok: boolean; rules: string[] };
}

/** Retire une règle de blocage DeTecTX (invite UAC). */
export async function unblockRule(name: string): Promise<{ ok: boolean; rules: string[] }> {
  const res = await fetch(`${API_URL}/metrics/firewall/unblock`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { ok: boolean; rules: string[] };
}

export async function fetchConnections(): Promise<NetSnapshot> {
  const res = await fetch(`${API_URL}/metrics/connections`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as NetSnapshot;
}

export interface Shortcut {
  id: number;
  label: string;
  target: string;
  icon: string | null;
  created_at: string;
}

export async function fetchShortcuts(): Promise<Shortcut[]> {
  const res = await fetch(`${API_URL}/launcher`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Shortcut[];
}
export async function addShortcut(input: { label: string; target: string; icon?: string }): Promise<Shortcut> {
  const res = await fetch(`${API_URL}/launcher`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Shortcut;
}
export async function deleteShortcut(id: number): Promise<void> {
  const res = await fetch(`${API_URL}/launcher/${id}`, { method: "DELETE", headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
}
export async function launchShortcut(id: number): Promise<{ launched: boolean; label: string }> {
  const res = await fetch(`${API_URL}/launcher/${id}/launch`, { method: "POST", headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { launched: boolean; label: string };
}

export interface StartupItem {
  name: string;
  command: string;
  location: string;
  enabled: boolean;
  editable: boolean;
}

export async function fetchStartup(): Promise<StartupItem[]> {
  const res = await fetch(`${API_URL}/system/startup`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as StartupItem[];
}
export async function toggleStartup(name: string, enable: boolean): Promise<void> {
  const res = await fetch(`${API_URL}/system/startup/toggle`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ name, enable }),
  });
  if (!res.ok) throw new Error(await readError(res));
}
export async function createShortcut(input: { name: string; target: string; args?: string; workdir?: string }): Promise<{ created: boolean; path: string }> {
  const res = await fetch(`${API_URL}/system/shortcut`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { created: boolean; path: string };
}
export async function getLocation(): Promise<{ allowed: boolean }> {
  const res = await fetch(`${API_URL}/system/location`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { allowed: boolean };
}
export async function setLocation(allowed: boolean): Promise<{ allowed: boolean }> {
  const res = await fetch(`${API_URL}/system/location`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ allowed }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { allowed: boolean };
}

export interface MitreDetail {
  id: string;
  name: string | null;
  tactic: string | null; // identifiant ATT&CK ; null = technique non classée
  tactic_fr: string | null;
  count: number;
}

// ─────────────────────────────── posture du poste (5 piliers, constats sourcés)
export type PostureTone = "ok" | "warn" | "critical" | "unknown";
export type PillarKey = "threats" | "exposure" | "defense" | "visibility" | "health";
export type FindingLevel = "critical" | "high" | "medium" | "low" | "ok";

export interface Finding {
  id: string;
  pillar: PillarKey;
  level: FindingLevel; // ok = ce qui va bien (jamais en priorité)
  title: string;
  detail: string | null;
  source: string; // d'où vient le constat
  href: string | null; // page où agir
  action: string | null;
  at: string | null;
}

export interface Pillar {
  key: PillarKey;
  label: string;
  weight: number;
  score: number | null; // null = source indisponible
  tone: PostureTone;
  headline: string;
  href: string;
  findings: Finding[];
}

export interface Posture {
  score: number | null;
  tone: PostureTone;
  verdict: string;
  summary: string;
  pillars: Pillar[];
  priorities: Finding[];
  generated_at: string;
}

/** Badges vivants de la barre latérale (posture en cache 30 s côté serveur). */
export interface NavStats {
  posture_score: number | null;
  posture_tone: PostureTone;
  open_alerts: number;
  open_critical: number;
  events_5min: number;
  rules_enabled: number;
  cpu_percent: number | null;
  collection: "ok" | "degraded" | "down" | "unknown";
}

export async function fetchNavStats(): Promise<NavStats> {
  const res = await fetch(`${API_URL}/stats/nav`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as NavStats;
}

export async function fetchPosture(): Promise<Posture> {
  const res = await fetch(`${API_URL}/stats/posture`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Posture;
}

// ─────────────────────────────── couverture MITRE ATT&CK (réelle vs théorique)
export interface TechniqueCoverage {
  id: string;
  name: string | null;
  tactics: string[];
  district: string; // quartier de la ruche (1re tactique dans l'ordre de la kill chain)
  desc: string | null;
  url: string;
  by_source: Record<string, number>; // règles par source de données
  theoretical: number;
  effective: number;
  inert: number;
  alerts: number;
  alerts_open: number;
}

export interface MitreCoverage {
  attack_version: string | null;
  tactics: { id: string; name: string }[];
  sources: { id: string; label: string; available: boolean }[];
  techniques: TechniqueCoverage[];
  totals: {
    techniques: number;
    techniques_theoretical: number;
    techniques_effective: number;
    techniques_observed: number;
    rules_theoretical: number;
    rules_effective: number;
    rules_inert: number;
  };
  plan: { source: string; label: string; how: string | null; rules: number; techniques: number }[];
  observed_uncovered: string[];
}

export interface TechniqueDetail extends TechniqueCoverage {
  rules: { id: string; title: string; severity: string; origin: string; source: string; active: boolean; reason: string | null }[];
}

export async function fetchMitreCoverage(): Promise<MitreCoverage> {
  const res = await fetch(`${API_URL}/mitre/coverage`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as MitreCoverage;
}

export async function fetchTechnique(id: string): Promise<TechniqueDetail> {
  const res = await fetch(`${API_URL}/mitre/techniques/${encodeURIComponent(id)}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as TechniqueDetail;
}

export interface Overview {
  events_total: number;
  events_24h: number;
  alerts_total: number;
  by_severity: Record<string, number>;
  by_mitre: Record<string, number>;
  by_channel: Record<string, number>;
  events_series: number[];
  alerts_series: number[];
  mitre_details: MitreDetail[];
}

export async function fetchOverview(): Promise<Overview> {
  const res = await fetch(`${API_URL}/stats/overview`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Overview;
}

export interface IntelProvider {
  provider: string;
  available: boolean;
  verdict: string;
  score: number | null;
  detail: string;
  link: string | null;
}
export interface IntelResult {
  indicator: string;
  type: string;
  verdict: string;
  providers: IntelProvider[];
  cached: boolean;
}

export async function threatIntelLookup(indicator: string, type?: string): Promise<IntelResult> {
  const qs = new URLSearchParams({ indicator });
  if (type) qs.set("type", type);
  const res = await fetch(`${API_URL}/threatintel/lookup?${qs.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as IntelResult;
}

export async function notifyStatus(): Promise<{ discord: boolean }> {
  const res = await fetch(`${API_URL}/notifications/status`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { discord: boolean };
}

export async function notifyTest(): Promise<{ sent: boolean; detail: string }> {
  const res = await fetch(`${API_URL}/notifications/test`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { sent: boolean; detail: string };
}

export async function downloadReport(): Promise<void> {
  const res = await fetch(`${API_URL}/reports/summary.pdf`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "detectx-rapport.pdf";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface Explanation {
  alert_id: number;
  rule_title: string;
  severity: string;
  mitre_id: string;
  mitre_name: string;
  tactic: string;
  description: string;
  cause: string;
  impact: string;
  remediation: string[];
  commands: string[];
  references: string[];
  source: string;
  ai_narrative: string | null;
}

export async function explainAlert(id: number): Promise<Explanation> {
  const res = await fetch(`${API_URL}/ai/alerts/${id}/explain`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as Explanation;
}

export async function aiChat(
  question: string,
  alertId?: number,
): Promise<{ answer: string; provider: string }> {
  const res = await fetch(`${API_URL}/ai/chat`, {
    method: "POST",
    headers: { ...authHeaders(), "Content-Type": "application/json" },
    body: JSON.stringify({ question, alert_id: alertId ?? null }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { answer: string; provider: string };
}

export async function runDetection(): Promise<{ rules_run: number; alerts_created: number }> {
  const res = await fetch(`${API_URL}/detection/run`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as { rules_run: number; alerts_created: number };
}
