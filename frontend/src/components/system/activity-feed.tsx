"use client";

import { useState } from "react";
import type { ActivityEvent, ActivityKind } from "@/lib/activity";

type Filter = "all" | "process" | "network";

const FILTERS: { key: Filter; label: string; kinds: ActivityKind[] | null }[] = [
  { key: "all", label: "Tout", kinds: null },
  { key: "process", label: "Processus", kinds: ["proc_start", "proc_exit"] },
  { key: "network", label: "Réseau", kinds: ["port_open", "port_close", "remote_new"] },
];

const ICON: Record<ActivityKind, string> = {
  proc_start: "▶",
  proc_exit: "■",
  port_open: "◉",
  port_close: "○",
  remote_new: "↗",
};

const clock = (ms: number) => new Date(ms).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

interface ActivityFeedProps {
  events: ActivityEvent[];
  since: number | null; // début de la surveillance (1er instantané)
  alive: (pid: number) => boolean;
  onSelect: (pid: number) => void;
  className?: string;
}

/** Journal en direct : ce qui démarre, s'arrête, s'ouvre au réseau pendant que la page est ouverte. */
export function ActivityFeed({ events, since, alive, onSelect, className = "" }: ActivityFeedProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const kinds = FILTERS.find((f) => f.key === filter)?.kinds ?? null;
  const shown = kinds ? events.filter((e) => kinds.includes(e.kind)) : events;

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <span className="relative flex h-1.5 w-1.5 shrink-0">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
        <span className="eyebrow">Activité en direct</span>
        <div className="ml-auto flex gap-1" role="tablist" aria-label="Filtrer l'activité">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              role="tab"
              aria-selected={filter === f.key}
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-2 py-0.5 text-[11px] transition ${filter === f.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>
      <ol className="min-h-0 flex-1 overflow-y-auto py-1 text-xs" aria-live="polite">
        {shown.length === 0 && (
          <li className="px-4 py-6 text-center text-muted">
            {since === null ? "Premier relevé en cours…" : `Surveillance depuis ${clock(since)} : aucun changement pour l'instant.`}
          </li>
        )}
        {shown.map((e) => {
          const clickable = e.pid !== null && alive(e.pid);
          return (
            <li key={e.id} className="flex items-baseline gap-2 px-4 py-1 hover:bg-surface-2">
              <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">{clock(e.at)}</span>
              <span className="w-3 shrink-0 text-center" style={{ color: `var(--${e.tone})` }} aria-hidden="true">
                {ICON[e.kind]}
              </span>
              <span className="min-w-0 flex-1 truncate">
                {clickable ? (
                  <button onClick={() => onSelect(e.pid as number)} className="font-mono text-foreground hover:text-accent hover:underline">
                    {e.process ?? `PID ${e.pid}`}
                  </button>
                ) : (
                  <span className="font-mono text-muted">{e.process ?? (e.pid !== null ? `PID ${e.pid}` : "système")}</span>
                )}{" "}
                <span style={{ color: e.tone === "warn" ? "var(--warn)" : "var(--muted)" }}>{e.detail}</span>
              </span>
            </li>
          );
        })}
      </ol>
      <p className="border-t border-line px-4 py-1.5 text-[10px] text-muted">
        Relevé toutes les 3-5 s : un processus plus bref peut échapper à cette vue (Sysmon, lui, le trace).
      </p>
    </div>
  );
}
