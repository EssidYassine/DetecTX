"use client";

import { useEffect, useRef } from "react";
import type { ProcInfo } from "@/lib/api";
import { loadTone, machineLoad } from "@/lib/host";
import type { ProcTree } from "@/lib/proctree";
import { SelectionCard, type ProcActions } from "./process-details";

interface ProcessPanelProps {
  processes: ProcInfo[] | null; // top N par mémoire ; null = premier chargement
  tree: ProcTree | null;
  cpuCount: number;
  selected: number | null;
  highlight: number | null; // PID survolé dans la ville
  onHighlight: (pid: number | null) => void;
  onSelect: (pid: number | null) => void;
  actions: ProcActions;
  now: number;
  className?: string;
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;

/** Fiche du processus sélectionné + liste liée à la ville 3D (survol et sélection partagés). */
export function ProcessPanel({ processes, tree, cpuCount, selected, highlight, onHighlight, onSelect, actions, now, className = "" }: ProcessPanelProps) {
  const list = useRef<HTMLDivElement>(null);

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

      <SelectionCard
        selected={selected}
        node={selected === null ? null : (tree?.byPid.get(selected) ?? null)}
        cpuCount={cpuCount}
        now={now}
        actions={actions}
        onSelect={onSelect}
        emptyHint="Cliquez un bâtiment ou une ligne pour inspecter un processus."
      />

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
