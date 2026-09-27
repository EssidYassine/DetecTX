"use client";

import { useEffect, useRef, type ReactNode } from "react";
import type { ProcInfo } from "@/lib/api";
import { fmtBytes, loadTone, machineLoad } from "@/lib/host";
import { fmtAgo } from "@/lib/time";

interface ProcessPanelProps {
  processes: ProcInfo[] | null; // null = premier chargement
  cpuCount: number;
  selected: number | null;
  highlight: number | null; // PID survolé dans la ville
  onHighlight: (pid: number | null) => void;
  onSelect: (pid: number | null) => void;
  onKill: (proc: ProcInfo) => void;
  killing: boolean;
  notice: { tone: "ok" | "critical"; text: string } | null;
  now: number;
  className?: string;
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;

/** Fiche du processus sélectionné + liste liée à la ville 3D (survol et sélection partagés). */
export function ProcessPanel({
  processes,
  cpuCount,
  selected,
  highlight,
  onHighlight,
  onSelect,
  onKill,
  killing,
  notice,
  now,
  className = "",
}: ProcessPanelProps) {
  const list = useRef<HTMLDivElement>(null);
  const proc = selected === null ? null : (processes?.find((p) => p.pid === selected) ?? null);

  // Un bâtiment cliqué dans la ville : on amène sa ligne à l'écran.
  useEffect(() => {
    if (selected === null) return;
    list.current?.querySelector<HTMLElement>(`[data-pid="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Processus</span>
        <span className="text-xs text-muted">{processes ? `top ${processes.length} par mémoire` : "chargement…"}</span>
      </div>

      <div className="border-b border-line px-4 py-3">
        {selected === null ? (
          <p className="text-xs text-muted">
            Cliquez un bâtiment ou une ligne pour inspecter un processus. <span className="font-mono">Échap</span> pour désélectionner.
          </p>
        ) : proc === null ? (
          <p className="text-xs text-muted">
            Le PID {selected} n&apos;est plus dans la liste (terminé ou sorti du top).{" "}
            <button onClick={() => onSelect(null)} className="text-accent hover:underline">
              Fermer
            </button>
          </p>
        ) : (
          <ProcessDetails proc={proc} cpuCount={cpuCount} now={now} killing={killing} onKill={() => onKill(proc)} onClose={() => onSelect(null)} />
        )}
        {notice && (
          <p className="mt-2 text-xs" style={{ color: `var(--${notice.tone === "ok" ? "accent" : "critical"})` }} role="status">
            {notice.text}
          </p>
        )}
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto" onMouseLeave={() => onHighlight(null)}>
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-surface text-[10px] uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-1.5 font-medium">Nom</th>
              <th className="px-2 py-1.5 text-right font-medium">CPU</th>
              <th className="px-4 py-1.5 text-right font-medium">RAM</th>
            </tr>
          </thead>
          <tbody>
            {(processes ?? []).map((p) => {
              const load = machineLoad(p.cpu_percent, cpuCount);
              const active = p.pid === selected;
              const lit = p.pid === highlight;
              return (
                <tr
                  key={p.pid}
                  data-pid={p.pid}
                  onMouseEnter={() => onHighlight(p.pid)}
                  onClick={() => onSelect(active ? null : p.pid)}
                  aria-selected={active}
                  className={`cursor-pointer border-b border-line/40 transition-colors ${
                    active ? "bg-accent/15" : lit ? "bg-surface-2" : "hover:bg-surface-2"
                  }`}
                >
                  <td className="max-w-0 px-4 py-1.5">
                    <span className={`block truncate font-mono ${p.exe === null ? "text-muted" : ""}`} title={p.exe ?? "chemin inaccessible"}>
                      {p.name ?? "—"}
                    </span>
                  </td>
                  <td className="px-2 py-1.5 text-right font-mono tabular-nums" style={{ color: load >= 1 ? `var(--${loadTone(load)})` : "var(--muted)" }}>
                    {pct(load)}
                  </td>
                  <td className="px-4 py-1.5 text-right font-mono tabular-nums">{pct(p.memory_percent)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ProcessDetails({
  proc,
  cpuCount,
  now,
  killing,
  onKill,
  onClose,
}: {
  proc: ProcInfo;
  cpuCount: number;
  now: number;
  killing: boolean;
  onKill: () => void;
  onClose: () => void;
}) {
  const load = machineLoad(proc.cpu_percent, cpuCount);
  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold">{proc.name ?? "—"}</p>
          <p className="text-[11px] text-muted">PID {proc.pid}{proc.status ? ` · ${proc.status}` : ""}</p>
        </div>
        <button onClick={onClose} className="text-muted transition hover:text-foreground" aria-label="Désélectionner">
          ✕
        </button>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <Field label="Chemin">
          <span className="break-all font-mono">{proc.exe ?? <span className="text-muted">inaccessible (droits)</span>}</span>
        </Field>
        <Field label="Utilisateur">
          <span className="font-mono">{proc.username ?? <span className="text-muted">—</span>}</span>
        </Field>
        <Field label="Démarré">{proc.started_at ? fmtAgo(proc.started_at, now) : "—"}</Field>
        <Field label="Charge">
          <span className="font-mono tabular-nums">
            CPU <span style={{ color: `var(--${loadTone(load)})` }}>{pct(load)}</span> · RAM {pct(proc.memory_percent)}
            {proc.rss !== null && <span className="text-muted"> ({fmtBytes(proc.rss)})</span>}
          </span>
        </Field>
      </dl>
      <button
        onClick={onKill}
        disabled={killing}
        className="mt-2.5 w-full rounded-md border border-critical/40 px-3 py-1.5 text-xs font-medium text-critical transition hover:bg-critical/10 disabled:opacity-50"
      >
        {killing ? "Arrêt en cours…" : "Terminer le processus"}
      </button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
