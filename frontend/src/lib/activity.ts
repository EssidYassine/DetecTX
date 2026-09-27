// Journal d'activité en direct : différences entre deux instantanés successifs (processus,
// ports en écoute, connexions sortantes). Calculé dans le navigateur tant que la page est
// ouverte : c'est une vue « ce qui bouge maintenant », pas un historique. Un processus qui
// vit moins longtemps qu'un intervalle de rafraîchissement n'y apparaît pas : la trace
// exhaustive reste celle de Sysmon (événement 1) côté moteur de détection.

import type { NetSnapshot, ProcInfo } from "./api";

export type ActivityKind = "proc_start" | "proc_exit" | "port_open" | "port_close" | "remote_new";
export type ActivityTone = "accent" | "warn" | "muted";

export interface ActivityEvent {
  id: string;
  at: number; // ms, instant de DÉTECTION (au rafraîchissement), pas de l'événement exact
  kind: ActivityKind;
  pid: number | null;
  process: string | null;
  detail: string;
  tone: ActivityTone;
}

export const ACTIVITY_LIMIT = 200;

const procKey = (p: ProcInfo) => `${p.pid}@${p.started_at ?? ""}`;

export function diffProcesses(prev: ProcInfo[], next: ProcInfo[], at: number, flagged: (p: ProcInfo) => boolean): ActivityEvent[] {
  const before = new Map(prev.map((p) => [procKey(p), p]));
  const after = new Map(next.map((p) => [procKey(p), p]));
  const events: ActivityEvent[] = [];
  after.forEach((p, key) => {
    if (before.has(key)) return;
    const parent = next.find((q) => q.pid === p.ppid);
    const suspicious = flagged(p);
    events.push({
      id: `start:${key}`,
      at,
      kind: "proc_start",
      pid: p.pid,
      process: p.name,
      detail: parent?.name ? `lancé par ${parent.name}` : "nouveau processus",
      tone: suspicious ? "warn" : "accent",
    });
  });
  before.forEach((p, key) => {
    if (after.has(key)) return;
    events.push({ id: `exit:${key}:${at}`, at, kind: "proc_exit", pid: p.pid, process: p.name, detail: "terminé", tone: "muted" });
  });
  return events;
}

const portKey = (s: NetSnapshot["listening"][number]) => `${s.proto}:${s.ip}:${s.port}:${s.pid ?? ""}`;
const remoteKey = (c: NetSnapshot["connections"][number]) => `${c.pid ?? ""}>${c.rip}`;

export function diffNetwork(prev: NetSnapshot, next: NetSnapshot, at: number): ActivityEvent[] {
  const events: ActivityEvent[] = [];
  // TCP seulement : les sockets UDP (QUIC, DNS…) s'ouvrent et se ferment en continu.
  const tcp = (snap: NetSnapshot) => snap.listening.filter((s) => s.proto === "tcp");
  const before = new Map(tcp(prev).map((s) => [portKey(s), s]));
  const after = new Map(tcp(next).map((s) => [portKey(s), s]));
  after.forEach((s, key) => {
    if (before.has(key)) return;
    events.push({
      id: `open:${key}:${at}`,
      at,
      kind: "port_open",
      pid: s.pid,
      process: s.process,
      detail: `écoute ${s.proto.toUpperCase()} ${s.port}${s.exposed ? " · exposé au réseau" : " · local"}`,
      tone: s.exposed ? "warn" : "muted",
    });
  });
  before.forEach((s, key) => {
    if (after.has(key)) return;
    events.push({ id: `close:${key}:${at}`, at, kind: "port_close", pid: s.pid, process: s.process, detail: `n'écoute plus ${s.proto.toUpperCase()} ${s.port}`, tone: "muted" });
  });

  // Nouvelles destinations publiques par processus (une entrée par couple processus/IP).
  const known = new Set(prev.connections.map(remoteKey));
  const fresh = new Map<string, NetSnapshot["connections"][number]>();
  next.connections.forEach((c) => {
    if (c.scope !== "public") return;
    const key = remoteKey(c);
    if (!known.has(key) && !fresh.has(key)) fresh.set(key, c);
  });
  fresh.forEach((c, key) => {
    events.push({
      id: `remote:${key}:${at}`,
      at,
      kind: "remote_new",
      pid: c.pid,
      process: c.process,
      detail: `${c.status === "SYN_SENT" ? "tente de joindre" : "connecté à"} ${c.rip}:${c.rport}`,
      tone: c.status === "SYN_SENT" ? "warn" : "accent",
    });
  });
  return events;
}

/** Ajoute des événements en tête (plus récents d'abord) en bornant la taille du journal. */
export function pushEvents(log: ActivityEvent[], events: ActivityEvent[]): ActivityEvent[] {
  if (events.length === 0) return log;
  return [...events, ...log].slice(0, ACTIVITY_LIMIT);
}

// ─────────────────────────────── affichage condensé
export interface ActivityGroup {
  id: string;
  at: number;
  kind: ActivityKind;
  process: string | null;
  pids: number[];
  details: string[]; // détails distincts, dans l'ordre d'arrivée
  count: number;
  tone: ActivityTone;
}

const TONE_RANK: Record<ActivityTone, number> = { muted: 0, accent: 1, warn: 2 };

/**
 * Regroupe les événements d'un même relevé qui ont le même type et le même processus :
 * « chrome.exe · 3 processus lancés » au lieu de trois lignes. Le ton le plus fort l'emporte.
 */
export function coalesce(events: ActivityEvent[]): ActivityGroup[] {
  const groups: ActivityGroup[] = [];
  const index = new Map<string, ActivityGroup>();
  events.forEach((e) => {
    const key = `${e.at}|${e.kind}|${e.process ?? ""}`;
    const group = index.get(key);
    if (group) {
      group.count += 1;
      if (e.pid !== null && !group.pids.includes(e.pid)) group.pids.push(e.pid);
      if (!group.details.includes(e.detail)) group.details.push(e.detail);
      if (TONE_RANK[e.tone] > TONE_RANK[group.tone]) group.tone = e.tone;
      return;
    }
    const created: ActivityGroup = {
      id: e.id,
      at: e.at,
      kind: e.kind,
      process: e.process,
      pids: e.pid !== null ? [e.pid] : [],
      details: [e.detail],
      count: 1,
      tone: e.tone,
    };
    index.set(key, created);
    groups.push(created);
  });
  return groups;
}
