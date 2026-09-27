"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import type { TimelineDay } from "@/lib/api";
import { ScenePoster } from "@/components/three/scene-poster";
import type { TimelineHover, TimelineSelection } from "@/components/three/alert-timeline";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";

const AlertTimeline = dynamic(() => import("@/components/three/alert-timeline"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/timeline_poster.png" />,
});

const SEV: { key: "critical" | "high" | "medium" | "low"; label: string; color: string }[] = [
  { key: "critical", label: "critique", color: "var(--critical)" },
  { key: "high", label: "haute", color: "var(--warn)" },
  { key: "medium", label: "moyenne", color: "var(--accent)" },
  { key: "low", label: "faible", color: "var(--muted)" },
];
const hoverKey = (h: TimelineHover) => `${h.day}:${h.severity ?? "*"}`;

export function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

interface TimelinePanelProps {
  days: TimelineDay[];
  selection: TimelineSelection | null;
  onSelect: (selection: TimelineSelection | null) => void;
  className?: string;
}

/** Chronologie 3D des 30 derniers jours : survol = détail, clic = filtre du tableau. */
export function TimelinePanel({ days, selection, onSelect, className = "" }: TimelinePanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<TimelineHover>(panel, hoverKey);
  const total = days.reduce((s, d) => s + d.critical + d.high + d.medium + d.low, 0);
  const activeDays = days.filter((d) => d.critical + d.high + d.medium + d.low > 0).length;
  const hovered = hover ? days[hover.day] : null;

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Chronologie · 30 jours</span>
        <span className="flex items-center gap-3 text-xs">
          {selection && days[selection.day] && (
            <span className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-accent">
              {dayLabel(days[selection.day].date)}
              {selection.severity && ` · ${SEV.find((s) => s.key === selection.severity)?.label}`}
              <button onClick={() => onSelect(null)} className="text-muted hover:text-foreground" aria-label="Retirer la sélection">✕</button>
            </span>
          )}
          <span className="font-mono tabular-nums text-muted">
            {total} alerte{total > 1 ? "s" : ""} · {activeDays} jour{activeDays > 1 ? "s" : ""} actif{activeDays > 1 ? "s" : ""}
          </span>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <AlertTimeline days={days} selected={selection} onHover={onHover} onSelect={onSelect} />
        {/* Légende des rangées (critique à l'avant) */}
        <div className="pointer-events-none absolute left-3 top-2 flex gap-2 text-[10px] text-muted">
          {SEV.map((s) => (
            <span key={s.key} className="flex items-center gap-1">
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
              {s.label}
            </span>
          ))}
        </div>
      </div>

      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-medium capitalize">{dayLabel(hovered.date)}</p>
          {hover.severity ? (
            <p>
              <span className="font-mono tabular-nums">{hovered[hover.severity]}</span> alerte(s){" "}
              <span style={{ color: SEV.find((s) => s.key === hover.severity)?.color }}>{SEV.find((s) => s.key === hover.severity)?.label}</span>
            </p>
          ) : (
            <div className="flex flex-wrap gap-x-2">
              {SEV.map((s) => (
                <span key={s.key} className="font-mono tabular-nums" style={{ color: hovered[s.key] ? s.color : "var(--muted)" }}>
                  {hovered[s.key]} {s.label.slice(0, 4)}.
                </span>
              ))}
            </div>
          )}
          <p className="mt-0.5 text-[10px] text-muted">Clic : filtrer le tableau</p>
        </HoverTip>
      )}
    </div>
  );
}
