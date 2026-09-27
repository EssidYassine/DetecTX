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
  timestamp: string;
  channel: string;
  event_id: number | null;
  provider: string | null;
  computer: string | null;
  level: string | null;
  message: string | null;
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
  minutes?: number;
}): Promise<EventPage> {
  const qs = new URLSearchParams();
  qs.set("offset", String(params.offset ?? 0));
  qs.set("limit", String(params.limit ?? 50));
  if (params.q) qs.set("q", params.q);
  if (params.channel) qs.set("channel", params.channel);
  if (params.minutes) qs.set("minutes", String(params.minutes));

  const res = await fetch(`${API_URL}/events?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as EventPage;
}

export type AlertStatus = "new" | "ack" | "closed";
export type Resolution = "true_positive" | "false_positive" | "benign";

export interface Alert {
  id: number;
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
  status?: AlertStatus;
  since?: string; // ISO 8601, inclus
  until?: string; // ISO 8601, exclu
  q?: string;
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

  const res = await fetch(`${API_URL}/alerts?${qs.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(await readError(res));
  return (await res.json()) as AlertPage;
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
