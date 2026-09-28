"use client";

import type { EventHistogram } from "@/lib/api";
import { THEMES } from "@/lib/events-ui";
import { ThemeIcon } from "./theme-icon";

interface ThemeStripProps {
  histogram: EventHistogram | null;
  active: string | null;
  onPick: (theme: string | null) => void;
  className?: string;
}

/** Les six familles d'activité d'un coup d'œil (volume et alertes sur la période du relief) ; clic = filtrer. */
export function ThemeStrip({ histogram, active, onPick, className = "" }: ThemeStripProps) {
  if (!histogram) return null;
  return (
    <div className={`flex gap-1.5 ${className}`} role="group" aria-label="Filtrer par thème">
      {histogram.lanes.map((lane) => {
        const theme = THEMES[lane.key];
        const count = (histogram.counts[lane.key] ?? []).reduce((a, b) => a + b, 0);
        const alerts = histogram.alerts.filter((a) => a.lane === lane.key).reduce((s, a) => s + a.count, 0);
        const on = active === lane.key;
        return (
          <button
            key={lane.key}
            onClick={() => onPick(on ? null : lane.key)}
            aria-pressed={on}
            title={`${lane.label} : ${count.toLocaleString("fr-FR")} événement(s)${alerts ? `, ${alerts} alerte(s)` : ""}`}
            className={`group flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-left transition ${
              on ? "border-accent/60 bg-accent/15" : "border-line bg-surface hover:border-accent/40"
            } ${count === 0 ? "opacity-50" : ""}`}
          >
            <ThemeIcon icon={theme?.icon ?? "window"} className={`h-4 w-4 shrink-0 ${on ? "text-accent" : "text-muted group-hover:text-accent"}`} />
            <span className="leading-tight">
              <span className="block text-[10px] text-muted">{theme?.label ?? lane.label}</span>
              <span className="flex items-baseline gap-1.5 font-mono text-xs tabular-nums">
                {count.toLocaleString("fr-FR")}
                {alerts > 0 && <span className="text-[10px] text-critical">▲{alerts}</span>}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
