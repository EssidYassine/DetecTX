"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AlertCase, AlertStatus, Resolution, TriageInput } from "@/lib/api";
import { caseStatus, isOpen, openCount, SEVERITIES, SEVERITY_LABEL, SEVERITY_TONE, type Severity } from "@/lib/cases";
import { TACTICS, laneOf } from "@/lib/mitre";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/triage";
import { fmtAgo } from "@/lib/time";

export type StatusFilter = AlertStatus | "open" | "all";
export type ViewMode = "cases" | "alerts";

/** Filtres partagés par la vue « Dossiers » et la vue « Alertes » (une ligne par alerte). */
export interface QueueQuery {
  status: StatusFilter;
  severity: Severity | "all";
  mitre: string | null;
  day: { since: string; until: string; label: string; date: string } | null;
  q: string;
}

export const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: "open", label: "À traiter" },
  { key: "new", label: "Nouvelles" },
  { key: "ack", label: "En cours" },
  { key: "closed", label: "Clôturées" },
  { key: "all", label: "Toutes" },
];
const SHORTCUT_RESOLUTION: Record<string, Resolution> = { f: "false_positive", v: "true_positive", b: "benign" };

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

interface CaseListProps {
  query: QueueQuery;
  onQuery: (patch: Partial<QueueQuery>) => void;
  counts: Partial<Record<StatusFilter, number>>;
  cases: AlertCase[] | null;
  loading: boolean;
  error: string | null;
  selected: string | null;
  onSelect: (ruleId: string) => void;
  onTriage: (ruleId: string, input: TriageInput) => void;
  now: number;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  className?: string;
}

/** File des dossiers : une ligne par règle déclenchée, triée « ouvert, grave, récent ». */
export function CaseList({ query, onQuery, counts, cases, loading, error, selected, onSelect, onTriage, now, mode, onMode, className = "" }: CaseListProps) {
  const items = useMemo(() => cases ?? [], [cases]);
  const index = Math.max(0, items.findIndex((c) => c.rule_id === selected));

  // Raccourcis façon outil SOC, appliqués au dossier sélectionné (inactifs pendant la saisie).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey || items.length === 0) return;
      const key = e.key.toLowerCase();
      const current = items[index];
      if (key === "j" || key === "arrowdown") onSelect(items[Math.min(index + 1, items.length - 1)].rule_id);
      else if (key === "k" || key === "arrowup") onSelect(items[Math.max(index - 1, 0)].rule_id);
      else if (key === "a" && current) onTriage(current.rule_id, { status: "ack" });
      else if (key === "r" && current) onTriage(current.rule_id, { status: "new" });
      else if (key in SHORTCUT_RESOLUTION && current) onTriage(current.rule_id, { status: "closed", resolution: SHORTCUT_RESOLUTION[key] });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, index, onSelect, onTriage]);

  // Défile jusqu'à la ligne sélectionnée (navigation clavier ou clic dans le radar).
  useEffect(() => {
    if (selected) document.getElementById(`case-${selected}`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <QueueFrame query={query} onQuery={onQuery} counts={counts} mode={mode} onMode={onMode} className={className}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && <p className="p-6 text-center text-sm text-critical">{error}</p>}
        {!error && !loading && items.length === 0 && (
          <p className="p-8 text-center text-sm text-muted">
            {query.status === "open" ? "Aucun dossier à traiter pour ces filtres. La file est vide." : "Aucun dossier pour ces filtres."}
          </p>
        )}
        <ul className={loading ? "opacity-50" : ""} aria-label="Dossiers d'alertes">
          {items.map((c) => (
            <CaseRow key={c.rule_id} c={c} active={c.rule_id === selected} now={now} onClick={() => onSelect(c.rule_id)} />
          ))}
        </ul>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-1.5 text-[11px] text-muted">
        <span className="hidden font-mono 2xl:inline">J/K naviguer · A prendre en charge · F/V/B clôturer (faux/vrai positif, bénin) · R rouvrir</span>
        <span className="ml-auto tabular-nums">
          {items.length} dossier(s) · {items.reduce((s, c) => s + c.count, 0)} alerte(s)
        </span>
      </div>
    </QueueFrame>
  );
}

function CaseRow({ c, active, now, onClick }: { c: AlertCase; active: boolean; now: number; onClick: () => void }) {
  const open = isOpen(c);
  const tone = open ? SEVERITY_TONE[c.severity] : "muted";
  const status = caseStatus(c);
  const tactic = TACTICS[laneOf(c.tactic)];
  return (
    <li id={`case-${c.rule_id}`}>
      <button
        onClick={onClick}
        aria-current={active}
        className={`relative grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-line/50 py-2 pl-5 pr-4 text-left transition ${
          active ? "bg-accent/10" : "hover:bg-surface-2/70"
        } ${open ? "" : "opacity-60"}`}
      >
        <span className="absolute inset-y-1.5 left-1.5 w-1 rounded-full" style={{ backgroundColor: `var(--${tone})` }} aria-hidden="true" />
        <span className="min-w-0">
          <span className="flex items-center gap-2">
            <span className="shrink-0 rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-wide" style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}>
              {SEVERITY_LABEL[c.severity]}
            </span>
            <span className="truncate text-sm font-medium">{c.rule_title}</span>
            {c.count > 1 && <span className="shrink-0 rounded bg-surface-2 px-1.5 font-mono text-[11px] tabular-nums">×{c.count}</span>}
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-[11px] text-muted">
            <span className="shrink-0">{tactic.label}</span>
            {c.mitre && <span className="shrink-0 font-mono text-accent">{c.mitre}</span>}
            {c.latest_message && <span className="truncate font-mono opacity-80">· {c.latest_message}</span>}
          </span>
        </span>
        <span className="flex items-center gap-4">
          <StatusBar c={c} />
          <span className="w-10 text-right font-mono text-sm font-semibold tabular-nums" title="Risque (0-100)">
            {c.risk}
          </span>
          <span className="w-20 text-right text-[11px] text-muted">
            <span className="block" style={{ color: `var(--${STATUS_TONE[status]})` }}>
              {STATUS_LABEL[status]}
            </span>
            {fmtAgo(c.last_seen, now)}
          </span>
        </span>
      </button>
    </li>
  );
}

/** Proportion nouvelles / en cours / closes du dossier. */
function StatusBar({ c }: { c: AlertCase }) {
  const parts: [AlertStatus, number][] = [
    ["new", c.by_status.new],
    ["ack", c.by_status.ack],
    ["closed", c.by_status.closed],
  ];
  return (
    <span className="hidden w-20 flex-col gap-1 lg:flex" title={parts.map(([s, n]) => `${n} ${STATUS_LABEL[s].toLowerCase()}`).join(" · ")}>
      <span className="flex h-1.5 overflow-hidden rounded-full bg-line">
        {parts.map(([s, n]) => (n ? <span key={s} style={{ flexGrow: n, backgroundColor: `var(--${STATUS_TONE[s]})` }} /> : null))}
      </span>
      <span className="font-mono text-[10px] tabular-nums text-muted">
        {openCount(c)}/{c.count} ouvertes
      </span>
    </span>
  );
}

/** Cadre commun des deux vues : bascule Dossiers/Alertes, statut, sévérité, recherche, filtres actifs. */
export function QueueFrame({
  query,
  onQuery,
  counts,
  mode,
  onMode,
  className = "",
  children,
}: {
  query: QueueQuery;
  onQuery: (patch: Partial<QueueQuery>) => void;
  counts: Partial<Record<StatusFilter, number>>;
  mode: ViewMode;
  onMode: (mode: ViewMode) => void;
  className?: string;
  children: ReactNode;
}) {
  const [typed, setTyped] = useState(query.q);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (typed.trim() !== query.q) onQuery({ q: typed.trim() });
    }, 300);
    return () => window.clearTimeout(t);
  }, [typed, query.q, onQuery]);

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <div className="flex rounded-lg border border-line p-0.5 text-xs" role="tablist" aria-label="Présentation">
          {(
            [
              ["cases", "Dossiers"],
              ["alerts", "Alertes"],
            ] as const
          ).map(([key, label]) => (
            <button key={key} role="tab" aria-selected={mode === key} onClick={() => onMode(key)} className={`rounded-md px-2.5 py-1 transition ${mode === key ? "bg-accent text-accent-fg" : "text-muted hover:text-foreground"}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="flex gap-0.5" role="tablist" aria-label="Statut">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={query.status === t.key}
              onClick={() => onQuery({ status: t.key })}
              className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 text-xs transition ${query.status === t.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
            >
              {t.label}
              {counts[t.key] !== undefined && <span className="font-mono text-[10px] tabular-nums">{counts[t.key]}</span>}
            </button>
          ))}
        </div>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value.slice(0, 200))}
          placeholder="Rechercher une règle, un détail…"
          aria-label="Recherche"
          className="ml-auto w-36 min-w-0 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-xs outline-none focus:border-accent 2xl:w-56"
        />
      </div>
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line/60 px-3 py-1.5">
        {(["all", ...SEVERITIES] as const).map((s) => (
          <button
            key={s}
            onClick={() => onQuery({ severity: s })}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition ${
              query.severity === s ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-foreground"
            }`}
          >
            {s !== "all" && <span className="h-1.5 w-1.5 rotate-45" style={{ backgroundColor: `var(--${SEVERITY_TONE[s]})` }} />}
            {s === "all" ? "Toutes sévérités" : SEVERITY_LABEL[s]}
          </button>
        ))}
        {query.mitre && <Chip label={`MITRE ${query.mitre}`} onClear={() => onQuery({ mitre: null })} />}
        {query.day && <Chip label={query.day.label} onClear={() => onQuery({ day: null })} />}
      </div>
      {children}
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-[11px] text-accent">
      {label}
      <button onClick={onClear} className="text-muted transition hover:text-foreground" aria-label={`Retirer le filtre ${label}`}>
        ✕
      </button>
    </span>
  );
}
