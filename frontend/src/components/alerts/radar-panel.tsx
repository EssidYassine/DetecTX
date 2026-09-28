"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import type { AlertCase, TimelineDay } from "@/lib/api";
import { attackSequence, fmtWhen, isOpen, SEVERITIES, SEVERITY_LABEL, SEVERITY_TONE, tacticLabel } from "@/lib/cases";
import { TACTICS } from "@/lib/mitre";
import { fmtAgo } from "@/lib/time";
import { ScenePoster } from "@/components/three/scene-poster";
import type { RadarHover } from "@/components/three/threat-radar";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "@/components/system/panel-shell";

const ThreatRadar = dynamic(() => import("@/components/three/threat-radar"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/radar_poster.png" />,
});

const hoverKey = (h: RadarHover) => h.ruleId;

export function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("fr-FR", { weekday: "short", day: "numeric", month: "short" });
}

interface RadarPanelProps {
  cases: AlertCase[];
  days: TimelineDay[];
  now: number;
  selected: string | null;
  onSelect: (ruleId: string) => void;
  day: string | null;
  onDay: (day: string | null) => void;
  className?: string;
}

/** Radar des menaces : où (tactique), quand (distance au poste) et à quel point (hauteur). */
export function RadarPanel({ cases, days, now, selected, onSelect, day, onDay, className = "" }: RadarPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<RadarHover>(panel, hoverKey);
  const hovered = hover ? cases.find((c) => c.rule_id === hover.ruleId) : undefined;
  const sequence = attackSequence(cases);
  const open = cases.filter(isOpen).length;

  return (
    <PanelShell
      panelRef={panel}
      title="Radar des menaces"
      className={className}
      aside={
        <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted xl:flex">
          <span>distance = ancienneté</span>
          <span>hauteur = risque</span>
          <span>secteur = tactique ATT&amp;CK</span>
        </span>
      }
      footer={<DayStrip days={days} day={day} onDay={onDay} />}
    >
      <ThreatRadar cases={cases} now={now} selected={selected} onHover={onHover} onSelect={(id) => id && onSelect(id)} />

      <div className="pointer-events-none absolute left-3 top-2.5 space-y-1 text-[10px] text-muted [@media(max-height:860px)]:hidden">
        {SEVERITIES.map((s) => (
          <span key={s} className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rotate-45" style={{ backgroundColor: `var(--${SEVERITY_TONE[s]})` }} />
            {SEVERITY_LABEL[s]}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rotate-45 bg-muted opacity-50" />
          clos
        </span>
      </div>

      <div className="pointer-events-none absolute right-3 top-2.5 text-right text-[11px]">
        <p className="font-mono text-lg font-semibold tabular-nums leading-none">{open}</p>
        <p className="text-muted">dossier(s) ouvert(s)</p>
      </div>

      {sequence.length > 1 && (
        <div className="pointer-events-none absolute bottom-2.5 left-3 hidden text-[10px] md:block">
          <p className="mb-1 uppercase tracking-wider text-muted">Ordre d&apos;apparition</p>
          <ol className="relative space-y-0.5 border-l border-line pl-2.5">
            {sequence.map((s, i) => (
              <li key={s.tactic} className="flex items-baseline gap-1.5" title={TACTICS[s.tactic].label}>
                <span className="font-mono text-muted">{i + 1}</span>
                <span className="font-medium">{TACTICS[s.tactic].short}</span>
                <span className="font-mono text-muted">{fmtWhen(s.at)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}

      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-medium">{hovered.rule_title}</p>
          <p className="mt-0.5" style={{ color: `var(--${isOpen(hovered) ? SEVERITY_TONE[hovered.severity] : "muted"})` }}>
            {SEVERITY_LABEL[hovered.severity]} · risque {hovered.risk}
            {!isOpen(hovered) && " · clos"}
          </p>
          <p className="mt-0.5 text-muted">
            {tacticLabel(hovered.tactic)}
            {hovered.mitre && <span className="font-mono"> · {hovered.mitre}</span>}
          </p>
          <p className="mt-0.5 font-mono tabular-nums">
            ×{hovered.count} · dernière {fmtAgo(hovered.last_seen, now)}
          </p>
          <p className="mt-0.5 text-[10px] text-muted">Clic : ouvrir le dossier</p>
        </HoverTip>
      )}
    </PanelShell>
  );
}

/** 30 derniers jours, barres empilées par sévérité ; clic = filtrer la file sur ce jour. */
function DayStrip({ days, day, onDay }: { days: TimelineDay[]; day: string | null; onDay: (day: string | null) => void }) {
  const totals = days.map((d) => d.critical + d.high + d.medium + d.low);
  const max = Math.max(1, ...totals);
  return (
    <div className="flex items-center gap-3">
      <span className="shrink-0">30 jours</span>
      <div className="flex h-7 min-w-0 flex-1 items-end gap-[2px]" role="group" aria-label="Alertes par jour (30 jours)">
        {days.map((d, i) => {
          const total = totals[i];
          const active = day === d.date;
          const h = total ? 18 + 82 * (Math.log1p(total) / Math.log1p(max)) : 6;
          return (
            <button
              key={d.date}
              onClick={() => onDay(active ? null : d.date)}
              aria-pressed={active}
              title={`${dayLabel(d.date)} : ${total} alerte(s)${total ? ` — ${SEVERITIES.filter((s) => d[s]).map((s) => `${d[s]} ${SEVERITY_LABEL[s].toLowerCase()}`).join(", ")}` : ""}`}
              className={`group flex h-full min-w-0 flex-1 flex-col justify-end rounded-sm ${active ? "bg-accent/15 outline outline-1 outline-accent/60" : "hover:bg-surface-2"}`}
            >
              <span className="flex w-full flex-col-reverse overflow-hidden rounded-sm" style={{ height: `${h}%` }}>
                {total === 0 ? (
                  <span className="h-full w-full bg-line/60" />
                ) : (
                  [...SEVERITIES].reverse().map((s) =>
                    d[s] ? <span key={s} style={{ flexGrow: d[s], backgroundColor: `var(--${SEVERITY_TONE[s]})` }} className="w-full opacity-80 group-hover:opacity-100" /> : null,
                  )
                )}
              </span>
            </button>
          );
        })}
      </div>
      <span className="shrink-0">
        {day ? (
          <button onClick={() => onDay(null)} className="rounded-full border border-accent/40 bg-accent/10 px-2 py-0.5 text-accent">
            {dayLabel(day)} ✕
          </button>
        ) : (
          "auj."
        )}
      </span>
    </div>
  );
}
