// Agrégation des sockets pour la constellation réseau : un nœud par IP distante, un « mât »
// par port en écoute. Sans dépendance three.js (utilisé aussi par les listes).

import type { NetConnection, NetScope, NetSnapshot } from "./api";

export interface NetNode {
  ip: string;
  scope: NetScope;
  connections: NetConnection[];
  processes: string[]; // noms distincts
  established: number;
  /** Tentatives sans réponse (SYN_SENT) : balayage, C2 injoignable, pare-feu qui bloque… */
  attempts: number;
}

export interface PortNode {
  key: string;
  proto: "tcp" | "udp";
  port: number;
  /**
   * Service TCP en écoute joignable depuis le réseau. Les sockets UDP sans pair ne comptent
   * pas : ce sont surtout des sockets clients (QUIC, DNS, mDNS), pas des serveurs.
   */
  exposed: boolean;
  binds: string[]; // adresses de liaison
  processes: string[];
  pids: number[];
}

export const MAX_NODES = 150;
export const MAX_PORTS = 80;

const uniq = (values: (string | null)[]) => [...new Set(values.filter((v): v is string => Boolean(v)))];

export function aggregateNodes(snapshot: NetSnapshot | null): NetNode[] {
  if (!snapshot) return [];
  const byIp = new Map<string, NetConnection[]>();
  snapshot.connections.forEach((c) => byIp.set(c.rip, [...(byIp.get(c.rip) ?? []), c]));
  const nodes: NetNode[] = [];
  byIp.forEach((conns, ip) => {
    nodes.push({
      ip,
      scope: conns[0].scope,
      connections: conns,
      processes: uniq(conns.map((c) => c.process)),
      established: conns.filter((c) => c.status === "ESTABLISHED").length,
      attempts: conns.filter((c) => c.status === "SYN_SENT").length,
    });
  });
  // Les plus actifs d'abord : si on tronque, on garde ce qui compte.
  nodes.sort((a, b) => b.attempts - a.attempts || b.established - a.established || b.connections.length - a.connections.length);
  return nodes.slice(0, MAX_NODES);
}

export function aggregatePorts(snapshot: NetSnapshot | null): PortNode[] {
  if (!snapshot) return [];
  const byPort = new Map<string, PortNode>();
  snapshot.listening.forEach((s) => {
    const key = `${s.proto}:${s.port}`;
    const node = byPort.get(key) ?? { key, proto: s.proto, port: s.port, exposed: false, binds: [], processes: [], pids: [] };
    node.exposed ||= s.exposed && s.proto === "tcp";
    if (!node.binds.includes(s.ip)) node.binds.push(s.ip);
    if (s.process && !node.processes.includes(s.process)) node.processes.push(s.process);
    if (s.pid !== null && !node.pids.includes(s.pid)) node.pids.push(s.pid);
    byPort.set(key, node);
  });
  return [...byPort.values()].sort((a, b) => Number(b.exposed) - Number(a.exposed) || a.port - b.port).slice(0, MAX_PORTS);
}

/** Hachage FNV-1a 32 bits : position stable d'une IP / d'un port d'un rafraîchissement à l'autre. */
export function hash32(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export const SCOPE_LABEL: Record<NetScope, string> = { public: "Internet", private: "réseau local", other: "autre" };
