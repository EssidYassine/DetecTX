"use client";

import { useMemo, useState } from "react";
import { coalesce, type ActivityEvent, type ActivityGroup, type ActivityKind } from "@/lib/activity";

type Filter = "all" | "process" | "network" | "startup";

const FILTERS: { key: Filter; label: string; kinds: ActivityKind[] | null }[] = [
  { key: "all", label: "Tout", kinds: null },
  { key: "process", label: "Processus", kinds: ["proc_start", "proc_exit"] },
  { key: "network", label: "Réseau", kinds: ["port_open", "port_close", "remote_new"] },
  { key: "startup", label: "Démarrage", kinds: ["persist_new"] },
];

const ICON: Record<ActivityKind, string> = {
  proc_start: "▶",
  proc_exit: "■",
  port_open: "◉",
  port_close: "○",
  remote_new: "↗",
  persist_new: "↻",
};

/** Phrase principale d'un groupe d'événements (au singulier ou au pluriel). */
function headline(g: ActivityGroup): string {
  const many = g.count > 1;
  switch (g.kind) {
    case "proc_start":
      return many ? `${g.count} processus lancés` : "a démarré";
    case "proc_exit":
      return many ? `${g.count} processus terminés` : "s'est terminé";
    case "port_open":
      return many ? `${g.count} ports ouverts` : "écoute un nouveau port";
    case "port_close":
      return many ? `${g.count} ports fermés` : "a fermé un port";
    case "remote_new":
      return many ? `${g.count} nouvelles destinations` : "nouvelle destination";
    case "persist_new":
      return many ? `${g.count} nouvelles persistances` : "nouvelle persistance";
  }
}

function sub(g: ActivityGroup): string | null {
  if (g.kind === "proc_exit") return null;
  const first = g.details[0];
  return g.details.length > 1 ? `${first} · +${g.details.length - 1}` : first;
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "à l'instant";
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  return `${Math.floor(s / 3600)} h`;
}

interface ActivityFeedProps {
  events: ActivityEvent[];
  since: number | null; // début de la surveillance (1er instantané)
  now: number;
  alive: (pid: number) => boolean;
  onSelect: (pid: number) => void;
  className?: string;
}

/** Journal en direct, condensé : ce qui démarre, s'arrête, s'ouvre au réseau. */
export function ActivityFeed({ events, since, now, alive, onSelect, className = "" }: ActivityFeedProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const groups = useMemo(() => {
    const kinds = FILTERS.find((f) => f.key === filter)?.kinds ?? null;
    return coalesce(kinds ? events.filter((e) => kinds.includes(e.kind)) : events);
  }, [events, filter]);

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
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

      <ol className="min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2 py-2" aria-live="polite">
        {groups.length === 0 && (
          <li className="px-2 py-8 text-center text-xs text-muted">
            {since === null ? "Premier relevé en cours…" : "Aucun changement depuis l'ouverture de la page."}
          </li>
        )}
        {groups.map((g) => {
          const target = g.pids.find(alive);
          const detail = sub(g);
          const color = `var(--${g.tone})`;
          return (
            <li key={g.id}>
              <button
                onClick={() => target !== undefined && onSelect(target)}
                disabled={target === undefined}
                className="flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition enabled:hover:bg-surface-2 disabled:cursor-default"
              >
                <span
                  className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md text-[10px]"
                  style={{ color, backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)` }}
                  aria-hidden="true"
                >
                  {ICON[g.kind]}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs">
                    <span className="font-medium">{g.process ?? "Système"}</span>{" "}
                    <span style={{ color: g.tone === "warn" ? "var(--warn)" : "var(--muted)" }}>{headline(g)}</span>
                  </span>
                  {detail && <span className="block truncate text-[11px] text-muted">{detail}</span>}
                </span>
                <span className="shrink-0 pt-0.5 text-[10px] tabular-nums text-muted">{ago(g.at, now)}</span>
              </button>
            </li>
          );
        })}
      </ol>
      {since !== null && (
        <p className="border-t border-line px-4 py-1.5 text-[10px] text-muted">
          Depuis {new Date(since).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })} · relevé toutes les 3-5 s
        </p>
      )}
    </div>
  );
}
