"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import type { EventHistogram } from "@/lib/api";
import { fmtHourRange, PERIODS, THEMES, type PeriodKey } from "@/lib/events-ui";
import { ScenePoster } from "@/components/three/scene-poster";
import type { ReliefHover, ReliefSlice } from "@/components/three/event-relief";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "@/components/system/panel-shell";
import { ThemeIcon } from "./theme-icon";

const EventRelief = dynamic(() => import("@/components/three/event-relief"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/relief_poster.png" />,
});

const hoverKey = (h: ReliefHover) => `${h.lane}:${h.bin}`;
const SEVERITY_LABEL: Record<string, string> = { critical: "critique", high: "élevée", medium: "moyenne", low: "faible" };

interface ReliefPanelProps {
  histogram: EventHistogram | null;
  period: PeriodKey;
  onPeriod: (p: PeriodKey) => void;
  selected: ReliefSlice | null;
  onSelect: (slice: ReliefSlice | null) => void;
  className?: string;
}

/** Relief de l'activité : où et quand la machine s'est agitée, et où sont les alertes. */
export function ReliefPanel({ histogram, period, onPeriod, selected, onSelect, className }: ReliefPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<ReliefHover>(panel, hoverKey);
  const total = histogram ? Object.values(histogram.counts).reduce((s, v) => s + v.reduce((a, b) => a + b, 0), 0) : 0;
  const alertCount = histogram?.alerts.reduce((s, a) => s + a.count, 0) ?? 0;
  const hovered = hover && histogram ? (histogram.counts[hover.lane]?.[hover.bin] ?? 0) : 0;
  const hoverAlerts = hover && histogram ? histogram.alerts.filter((a) => a.bin === hover.bin && a.lane === hover.lane) : [];
  const theme = hover ? THEMES[hover.lane] : undefined;

  return (
    <PanelShell
      panelRef={panel}
      title="Relief de l'activité"
      className={className}
      aside={
        <div className="ml-auto flex items-center gap-3">
          <span className="hidden items-center gap-3 text-[11px] text-muted xl:flex">
            <span>hauteur = volume (log)</span>
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-critical" /> alertes
            </span>
          </span>
          <div className="flex gap-1" role="tablist" aria-label="Période du relief">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                role="tab"
                aria-selected={period === p.key}
                onClick={() => onPeriod(p.key)}
                className={`rounded-md px-2 py-0.5 text-[11px] transition ${period === p.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>
      }
      footer={
        <span className="flex flex-wrap justify-between gap-x-4 gap-y-1">
          <span>
            <b className="font-mono text-foreground">{total.toLocaleString("fr-FR")}</b> événements ·{" "}
            <b className="font-mono" style={{ color: alertCount ? "var(--critical)" : undefined }}>
              {alertCount}
            </b>{" "}
            alertes sur la période
          </span>
          <span>Cliquez un relief pour lire les événements de cette heure.</span>
        </span>
      }
    >
      {histogram ? <EventRelief histogram={histogram} selected={selected} onHover={onHover} onSelect={onSelect} /> : <ScenePoster src="/models/relief_poster.png" />}
      {histogram && total === 0 && (
        <p className="pointer-events-none absolute inset-x-0 top-3 text-center text-xs text-muted">Aucun événement sur cette période.</p>
      )}
      {hover && histogram && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="flex items-center gap-1.5 font-medium">
            {theme && <ThemeIcon icon={theme.icon} className="h-3.5 w-3.5 text-accent" />}
            {theme?.label ?? hover.lane}
          </span>
          <p className="mt-0.5 text-muted">{fmtHourRange(histogram.start, hover.bin)}</p>
          <p className="mt-0.5 font-mono tabular-nums">{hovered.toLocaleString("fr-FR")} événement(s)</p>
          {hoverAlerts.map((a) => (
            <p key={a.severity} className="mt-0.5" style={{ color: a.severity === "critical" ? "var(--critical)" : "var(--warn)" }}>
              {a.count} alerte(s) {SEVERITY_LABEL[a.severity] ?? a.severity}
            </p>
          ))}
          <p className="mt-0.5 text-[10px] text-muted">Clic : filtrer la liste</p>
        </HoverTip>
      )}
    </PanelShell>
  );
}
