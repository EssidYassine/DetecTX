"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ExposureSnapshot, PortExposure, PortVerdict, RiskLevel } from "@/lib/api";
import { ScenePoster } from "@/components/three/scene-poster";
import type { RampartHover } from "@/components/three/rampart";
import { portKey } from "@/lib/netmap";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "./panel-shell";

const Rampart = dynamic(() => import("@/components/three/rampart"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/rampart_poster.png" />,
});

export const VERDICT_LABEL: Record<PortVerdict, string> = { open: "joignable", blocked: "bloqué", local: "local", unknown: "indéterminé" };
const VERDICT_TONE: Record<PortVerdict, string> = { open: "warn", blocked: "accent", local: "muted", unknown: "muted" };
const RISK_LABEL: Record<RiskLevel, string> = { critical: "critique", high: "élevé", medium: "moyen", low: "faible", info: "aucun" };
const RISK_TONE: Record<RiskLevel, string> = { critical: "critical", high: "warn", medium: "warn", low: "accent", info: "muted" };
const PROFILE_LABEL: Record<string, string> = { public: "Public", private: "Privé", domain: "Domaine" };
const byKey = (h: RampartHover) => h.key;

/** Le pare-feu protège-t-il le profil réseau actif ? */
export function firewallOn(snap: ExposureSnapshot | null): boolean {
  if (!snap?.available) return true;
  return snap.profiles.active.every((p) => snap.profiles.states[p]?.enabled !== false);
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────── scène
interface RampartPanelProps {
  snapshot: ExposureSnapshot | null;
  selected: string | null;
  onSelect: (key: string | null) => void;
  className?: string;
}

export function RampartPanel({ snapshot, selected, onSelect, className }: RampartPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<RampartHover>(panel, byKey);
  const ports = snapshot?.ports ?? [];
  const hovered = hover ? ports.find((p) => portKey(p) === hover.key) : undefined;
  const s = snapshot?.summary;

  return (
    <PanelShell
      panelRef={panel}
      title="Rempart · pare-feu Windows"
      className={className}
      aside={
        <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted md:flex">
          <Legend color="var(--critical)" label="joignable (risque)" />
          <Legend color="var(--accent)" label="bloqué par le pare-feu" square />
          <Legend color="var(--muted)" label="local / indéterminé" square />
        </span>
      }
      footer={
        snapshot && !snapshot.available ? (
          <span className="text-warn">{snapshot.error ?? "Pare-feu illisible."} Exposition affichée sans garantie.</span>
        ) : (
          <span className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <span>
              <b className="font-mono" style={{ color: s?.open ? "var(--warn)" : undefined }}>{s?.open ?? "—"}</b> joignables depuis le réseau ·{" "}
              <b className="font-mono text-foreground">{s?.blocked ?? "—"}</b> bloqués par le pare-feu · <b className="font-mono text-foreground">{s?.local ?? "—"}</b> locaux
              {s?.unknown ? <> · {s.unknown} indéterminés</> : null}
            </span>
            <span>{snapshot ? `${snapshot.rules_count} règles entrantes analysées` : "lecture du pare-feu…"}</span>
          </span>
        )
      }
    >
      <Rampart ports={ports} firewallOn={firewallOn(snapshot)} selected={selected} onHover={onHover} onSelect={onSelect} />
      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-mono font-medium">
            {hovered.proto.toUpperCase()} {hovered.port}
          </span>
          <span className="ml-2">{hovered.risk.service}</span>
          <p className="mt-0.5">
            <span style={{ color: `var(--${VERDICT_TONE[hovered.verdict]})` }}>{VERDICT_LABEL[hovered.verdict]}</span>
            {hovered.verdict === "open" && (
              <span style={{ color: `var(--${RISK_TONE[hovered.risk.level]})` }}> · risque {RISK_LABEL[hovered.risk.level]}</span>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{hovered.process ?? "processus inconnu"}</p>
        </HoverTip>
      )}
    </PanelShell>
  );
}

function Legend({ color, label, square = false }: { color: string; label: string; square?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 ${square ? "rounded-sm" : "rounded-full"}`} style={{ backgroundColor: color }} /> {label}
    </span>
  );
}

// ─────────────────────────────── liste + fiche
type Filter = "open" | "blocked" | "local" | "all";

interface PortsPanelProps {
  snapshot: ExposureSnapshot | null;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onOpenProcess: (pid: number) => void;
  className?: string;
}

export function PortsPanel({ snapshot, selected, onSelect, onOpenProcess, className = "" }: PortsPanelProps) {
  const ports = useMemo(() => snapshot?.ports ?? [], [snapshot]);
  const [filter, setFilter] = useState<Filter | null>(null);
  const effective: Filter = filter ?? (ports.some((p) => p.verdict === "open") ? "open" : "all");
  const shown = effective === "all" ? ports : ports.filter((p) => (effective === "open" ? p.verdict === "open" || p.verdict === "unknown" : p.verdict === effective));
  const current = selected ? ports.find((p) => portKey(p) === selected) : undefined;
  const active = snapshot?.profiles.active ?? [];
  const network = snapshot?.networks[0];
  const isPublic = active.includes("public");
  const count = (v: PortVerdict) => ports.filter((p) => p.verdict === v).length;

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="border-b border-line px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow">Réseau actuel</span>
          {snapshot && (
            <Chip tone={firewallOn(snapshot) ? "accent" : "critical"}>{firewallOn(snapshot) ? "pare-feu actif" : "pare-feu désactivé"}</Chip>
          )}
        </div>
        <p className="mt-1 truncate text-sm">
          {network ? network.name : "—"}
          {active.length > 0 && <span className="text-muted"> · profil {active.map((a) => PROFILE_LABEL[a] ?? a).join(", ")}</span>}
        </p>
        {isPublic && (
          <p className="mt-1 text-[11px] text-warn">Réseau Public : toute personne sur ce réseau peut tenter de joindre les ports ouverts.</p>
        )}
      </div>

      {current && <PortCard port={current} onClose={() => onSelect(null)} onOpenProcess={onOpenProcess} />}

      <div className="flex gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Filtrer les ports">
        {(
          [
            ["open", `Joignables (${count("open") + count("unknown")})`],
            ["blocked", `Bloqués (${count("blocked")})`],
            ["local", `Locaux (${count("local")})`],
            ["all", "Tous"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={effective === key}
            onClick={() => setFilter(key)}
            className={`rounded-lg px-2 py-0.5 text-[11px] transition ${effective === key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {shown.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted">{snapshot ? "Aucun port dans cette catégorie." : "Chargement…"}</li>}
        {shown.map((p) => {
          const key = portKey(p);
          return (
            <li key={key}>
              <button
                onClick={() => onSelect(key === selected ? null : key)}
                aria-current={key === selected}
                className={`flex w-full items-center gap-3 px-4 py-1.5 text-left transition-colors ${key === selected ? "bg-accent/10" : "hover:bg-surface-2"}`}
              >
                <span className="w-14 shrink-0 font-mono text-sm tabular-nums">{p.port}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium">{p.risk.service}</span>
                  <span className="block truncate font-mono text-[10px] text-muted">
                    {p.proto.toUpperCase()} · {p.process ?? "?"}
                  </span>
                </span>
                {p.verdict === "open" ? (
                  <Chip tone={RISK_TONE[p.risk.level]}>{RISK_LABEL[p.risk.level]}</Chip>
                ) : (
                  <Chip tone={VERDICT_TONE[p.verdict]}>{VERDICT_LABEL[p.verdict]}</Chip>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PortCard({ port, onClose, onOpenProcess }: { port: PortExposure; onClose: () => void; onOpenProcess: (pid: number) => void }) {
  const exposed = port.verdict === "open" || port.verdict === "unknown";
  return (
    <div className="max-h-[58%] shrink-0 overflow-y-auto border-b border-line px-4 py-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            <span className="font-mono">{port.port}</span> · {port.risk.service}
          </p>
          <p className="text-[11px] text-muted">
            {port.proto.toUpperCase()} · écoute sur {port.binds.join(", ")}
          </p>
        </div>
        <button onClick={onClose} className="text-muted transition hover:text-foreground" aria-label="Fermer la fiche">
          ✕
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip tone={VERDICT_TONE[port.verdict]}>{VERDICT_LABEL[port.verdict]}</Chip>
        {exposed && <Chip tone={RISK_TONE[port.risk.level]}>risque {RISK_LABEL[port.risk.level]}</Chip>}
        {exposed && <Chip tone="muted">ATT&amp;CK {port.risk.attack}</Chip>}
      </div>

      <dl className="mt-2.5 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted">Programme</dt>
        <dd className="min-w-0">
          {port.pid !== null ? (
            <button onClick={() => onOpenProcess(port.pid as number)} className="text-accent hover:underline">
              {port.process ?? "?"} <span className="font-mono text-muted">({port.pid})</span>
            </button>
          ) : (
            <span className="text-muted">inconnu</span>
          )}
        </dd>
        <dt className="text-muted">Pare-feu</dt>
        <dd>{port.reason}</dd>
        {port.rules.length > 0 && (
          <>
            <dt className="text-muted">Règles</dt>
            <dd className="space-y-1">
              {port.rules.map((r, i) => (
                <p key={`${r.name}-${i}`} className="rounded bg-surface-2 px-1.5 py-1">
                  <span style={{ color: r.action === "allow" ? "var(--warn)" : "var(--accent)" }}>{r.action === "allow" ? "Autorise" : "Bloque"}</span> ·{" "}
                  <span className="font-medium">{r.name}</span>
                  <span className="block text-[10px] text-muted">
                    par {r.by} · profils {r.profiles.map((p) => PROFILE_LABEL[p] ?? p).join(", ") || "—"} · depuis {r.remote === "*" ? "toute adresse" : r.remote}
                    {r.interfaces.length > 0 && ` · interface ${r.interfaces.join(", ")}`}
                  </span>
                </p>
              ))}
            </dd>
          </>
        )}
        {exposed && (
          <>
            <dt className="text-muted">Pourquoi</dt>
            <dd>{port.risk.why}</dd>
          </>
        )}
      </dl>

      {exposed && port.risk.advice.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-line p-2.5">
          <p className="eyebrow mb-1">Recommandations</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {port.risk.advice.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
