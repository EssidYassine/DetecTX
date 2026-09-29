"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import { threatIntelLookup, type IntelResult, type NetSnapshot } from "@/lib/api";
import { SCOPE_LABEL, type NetNode, type PortNode } from "@/lib/netmap";
import { ScenePoster } from "@/components/three/scene-poster";
import type { NetHover } from "@/components/three/network-map";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "./panel-shell";

const NetworkMap = dynamic(() => import("@/components/three/network-map"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/netmap_poster.png" />,
});

const hoverKey = (h: NetHover) => (h.kind === "node" ? `n:${h.ip}` : `p:${h.key}`);

const STATUS_LABEL: Record<string, string> = {
  ESTABLISHED: "établie",
  SYN_SENT: "tentative",
  TIME_WAIT: "fermeture",
  CLOSE_WAIT: "fermeture",
  FIN_WAIT1: "fermeture",
  FIN_WAIT2: "fermeture",
  LAST_ACK: "fermeture",
};
const statusTone = (s: string) => (s === "ESTABLISHED" ? "accent" : s === "SYN_SENT" ? "warn" : "muted");

interface MapPanelProps {
  nodes: NetNode[];
  ports: PortNode[];
  snapshot: NetSnapshot | null;
  selected: string | null;
  highlight: string | null;
  throughput: number;
  onHighlight: (ip: string | null) => void;
  onSelect: (ip: string | null) => void;
  className?: string;
}

/** Constellation 3D : survol = détail de l'hôte distant ou du port, clic = filtre la liste. */
export function NetworkMapPanel({ nodes, ports, snapshot, selected, highlight, throughput, onHighlight, onSelect, className }: MapPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<NetHover>(panel, hoverKey);
  const node = hover?.kind === "node" ? nodes.find((n) => n.ip === hover.ip) : undefined;
  const port = hover?.kind === "port" ? ports.find((p) => p.key === hover.key) : undefined;
  const established = snapshot?.connections.filter((c) => c.status === "ESTABLISHED").length ?? 0;
  const exposed = ports.filter((p) => p.exposed).length;

  return (
    <PanelShell
      panelRef={panel}
      title="Constellation réseau"
      className={className}
      aside={
        <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted md:flex">
          <Legend color="var(--accent)" label="Internet" />
          <Legend color="#22d3ee" label="LAN" />
          <Legend color="var(--warn)" label="tentative / port exposé" />
        </span>
      }
      footer={
        <span className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <span>
            <b className="font-mono text-foreground">{established}</b> connexions établies vers <b className="font-mono text-foreground">{nodes.length}</b> hôtes
            {snapshot && snapshot.loopback > 0 && <> · {snapshot.loopback} échanges locaux (loopback) non affichés</>}
          </span>
          <span>
            <b className="font-mono text-foreground">{ports.length}</b> ports en écoute · <b className="font-mono" style={{ color: exposed ? "var(--warn)" : undefined }}>{exposed}</b> exposés
          </span>
        </span>
      }
    >
      <NetworkMap
        nodes={nodes}
        ports={ports}
        selected={selected}
        highlight={highlight}
        throughput={throughput}
        onHover={(h) => {
          onHover(h);
          onHighlight(h?.kind === "node" ? h.ip : null);
        }}
        onSelect={onSelect}
      />
      {hover && node && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-mono font-medium">{node.ip}</span>
          <span className="ml-2 text-muted">{SCOPE_LABEL[node.scope]}</span>
          <p className="mt-0.5">
            {node.established} établie{node.established > 1 ? "s" : ""}
            {node.attempts > 0 && <span className="text-warn"> · {node.attempts} tentative{node.attempts > 1 ? "s" : ""}</span>}
            <span className="text-muted"> · ports {[...new Set(node.connections.map((c) => c.rport))].slice(0, 4).join(", ")}</span>
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{node.processes.join(", ") || "processus inconnu"}</p>
        </HoverTip>
      )}
      {hover && port && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-mono font-medium">
            {port.proto.toUpperCase()} {port.port}
          </span>
          <span className="ml-2" style={{ color: port.exposed ? "var(--warn)" : "var(--muted)" }}>
            {port.exposed ? "service exposé au réseau" : port.proto === "udp" ? "socket UDP (souvent client)" : "local uniquement"}
          </span>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">
            {port.processes.join(", ") || "processus inconnu"} · {port.binds.join(", ")}
          </p>
        </HoverTip>
      )}
    </PanelShell>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: color }} /> {label}
    </span>
  );
}

// ─────────────────────────────── liste + fiche de l'IP sélectionnée
type Tab = "connections" | "ports";
type Intel = IntelResult | "loading" | { error: string };

interface ListPanelProps {
  snapshot: NetSnapshot | null;
  nodes: NetNode[];
  ports: PortNode[];
  selected: string | null;
  highlight: string | null;
  onHighlight: (ip: string | null) => void;
  onSelect: (ip: string | null) => void;
  onOpenProcess: (pid: number) => void;
  className?: string;
}

export function ConnectionsPanel({ snapshot, nodes, ports, selected, highlight, onHighlight, onSelect, onOpenProcess, className = "" }: ListPanelProps) {
  const [tab, setTab] = useState<Tab>("connections");
  const [intel, setIntel] = useState<Record<string, Intel>>({});
  const node = selected ? nodes.find((n) => n.ip === selected) : undefined;
  const conns = (snapshot?.connections ?? []).filter((c) => !selected || c.rip === selected);

  async function checkReputation(ip: string) {
    setIntel((m) => ({ ...m, [ip]: "loading" }));
    try {
      const result = await threatIntelLookup(ip);
      setIntel((m) => ({ ...m, [ip]: result }));
    } catch (e) {
      setIntel((m) => ({ ...m, [ip]: { error: e instanceof Error ? e.message : "Échec de l'analyse" } }));
    }
  }

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Vue réseau">
        {(
          [
            { key: "connections", label: `Connexions (${snapshot?.connections.length ?? 0})` },
            { key: "ports", label: `Ports en écoute (${ports.length})` },
          ] as const
        ).map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            onClick={() => setTab(t.key)}
            className={`rounded-lg px-2.5 py-1 text-xs transition ${tab === t.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "connections" && selected && (
        <div className="border-b border-line px-4 py-3 text-xs">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="font-mono text-sm font-semibold">{selected}</p>
              <p className="text-[11px] text-muted">{node ? SCOPE_LABEL[node.scope] : "plus de connexion active"}</p>
            </div>
            <button onClick={() => onSelect(null)} className="text-muted hover:text-foreground" aria-label="Désélectionner">
              ✕
            </button>
          </div>
          {node && (
            <p className="mt-1.5 text-[11px]">
              Processus :{" "}
              {[...new Map(node.connections.filter((c) => c.pid !== null).map((c) => [c.pid, c.process])).entries()].map(([pid, name], i) => (
                <span key={pid}>
                  {i > 0 && ", "}
                  <button onClick={() => onOpenProcess(pid as number)} className="font-mono text-accent hover:underline" title="Voir dans l'arborescence">
                    {name ?? "?"} ({pid})
                  </button>
                </span>
              ))}
            </p>
          )}
          {node?.scope === "public" && <Reputation ip={selected} intel={intel[selected]} onCheck={() => void checkReputation(selected)} />}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => onHighlight(null)}>
        {tab === "connections" ? (
          <table className="w-full table-fixed text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface text-[10px] uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="w-[36%] px-4 py-1.5 font-medium">Processus</th>
                <th className="px-2 py-1.5 font-medium">Distant</th>
                <th className="w-[22%] px-4 py-1.5 text-right font-medium">État</th>
              </tr>
            </thead>
            <tbody>
              {conns.map((c, i) => (
                <tr
                  key={`${c.lport}-${c.rip}-${c.rport}-${i}`}
                  onMouseEnter={() => onHighlight(c.rip)}
                  onClick={() => onSelect(selected === c.rip ? null : c.rip)}
                  className={`cursor-pointer border-b border-line/40 transition-colors ${
                    c.rip === selected ? "bg-accent/15" : c.rip === highlight ? "bg-surface-2" : "hover:bg-surface-2"
                  }`}
                >
                  <td className="max-w-0 px-4 py-1.5">
                    <span className="block truncate font-mono">{c.process ?? (c.pid !== null ? `PID ${c.pid}` : "—")}</span>
                  </td>
                  <td className="max-w-0 px-2 py-1.5">
                    <span className="block truncate font-mono" title={`${c.rip}:${c.rport} (${SCOPE_LABEL[c.scope]})`}>
                      {c.rip}:{c.rport}
                    </span>
                  </td>
                  <td className="px-4 py-1.5 text-right" style={{ color: `var(--${statusTone(c.status)})` }}>
                    {STATUS_LABEL[c.status] ?? c.status.toLowerCase()}
                  </td>
                </tr>
              ))}
              {conns.length === 0 && (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-muted">
                    {snapshot ? "Aucune connexion distante." : "Chargement…"}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full text-left text-xs">
            <thead className="sticky top-0 z-10 bg-surface text-[10px] uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-1.5 font-medium">Port</th>
                <th className="px-2 py-1.5 font-medium">Processus</th>
                <th className="px-4 py-1.5 text-right font-medium">Portée</th>
              </tr>
            </thead>
            <tbody>
              {ports.map((p) => (
                <tr key={p.key} className="border-b border-line/40">
                  <td className="px-4 py-1.5 font-mono tabular-nums">
                    {p.proto.toUpperCase()} {p.port}
                  </td>
                  <td className="max-w-0 px-2 py-1.5">
                    {p.pids[0] !== undefined ? (
                      <button onClick={() => onOpenProcess(p.pids[0])} className="block max-w-full truncate font-mono hover:text-accent hover:underline" title={p.binds.join(", ")}>
                        {p.processes.join(", ") || `PID ${p.pids[0]}`}
                      </button>
                    ) : (
                      <span className="font-mono text-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-1.5 text-right" style={{ color: p.exposed ? "var(--warn)" : "var(--muted)" }} title={p.binds.join(", ")}>
                    {p.exposed ? "exposé" : p.proto === "udp" ? "socket UDP" : "local"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

const VERDICT_TONE: Record<string, string> = { malicious: "critical", suspicious: "warn", known: "warn", clean: "accent" };

function Reputation({ ip, intel, onCheck }: { ip: string; intel: Intel | undefined; onCheck: () => void }) {
  if (intel === undefined) {
    return (
      <button
        onClick={onCheck}
        title={`Envoie ${ip} aux services de Threat Intel configurés (VirusTotal, AbuseIPDB, MISP)`}
        className="mt-2 w-full rounded-md border border-line px-3 py-1.5 text-xs transition hover:border-accent/50 hover:text-accent"
      >
        Vérifier la réputation
      </button>
    );
  }
  if (intel === "loading") return <p className="mt-2 text-[11px] text-muted">Analyse en cours…</p>;
  if ("error" in intel) {
    return (
      <p className="mt-2 text-[11px] text-critical">
        {intel.error}{" "}
        <button onClick={onCheck} className="text-accent hover:underline">
          Réessayer
        </button>
      </p>
    );
  }
  const tone = VERDICT_TONE[intel.verdict] ?? "muted";
  return (
    <div className="mt-2 rounded-md border border-line p-2 text-[11px]">
      <p>
        Verdict :{" "}
        <span className="font-semibold" style={{ color: `var(--${tone})` }}>
          {intel.verdict}
        </span>
        {intel.cached && <span className="text-muted"> (cache)</span>}
      </p>
      <ul className="mt-1 space-y-0.5 text-muted">
        {intel.providers.map((p) => (
          <li key={p.provider} className="truncate">
            <span className="text-foreground">{p.provider}</span> · {p.available ? p.detail : "non configuré"}
          </li>
        ))}
      </ul>
    </div>
  );
}
