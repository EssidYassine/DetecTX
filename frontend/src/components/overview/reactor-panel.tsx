"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { Alert } from "@/lib/api";
import { postureLabel, postureTone } from "@/lib/posture";
import { SeverityBadge } from "@/components/ui";
import { ScenePoster } from "@/components/three/scene-poster";
import type { OrbHover } from "@/components/three/threat-reactor";
import { HoverTip, usePanelHover } from "./hover-tip";

const ThreatReactor = dynamic(() => import("@/components/three/threat-reactor"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/reactor_poster.png" />,
});

const SEVERITIES: { key: Alert["severity"]; label: string; color: string }[] = [
  { key: "critical", label: "Critique", color: "var(--critical)" },
  { key: "high", label: "Haute", color: "var(--warn)" },
  { key: "medium", label: "Moyenne", color: "var(--accent)" },
  { key: "low", label: "Faible", color: "var(--muted)" },
];

const orbKey = (h: OrbHover) => h.alert.id;

interface ReactorPanelProps {
  alerts: Alert[];
  total: number;
  bySeverity: Record<string, number>;
  score: number;
  highlightId: number | null;
  onSelect: (alert: Alert) => void;
  className?: string;
}

/** Widget menaces : chaque alerte en orbite autour du noyau, posture et sévérités en HUD. */
export function ReactorPanel({ alerts, total, bySeverity, score, highlightId, onSelect, className = "" }: ReactorPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onOrbHover, tip] = usePanelHover<OrbHover>(panel, orbKey);
  const tone = postureTone(score);
  const toneVar = tone === "ok" ? "accent" : tone;
  const criticals = bySeverity.critical ?? 0;

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Réacteur de menace</span>
        <span
          className="flex items-baseline gap-1.5 text-xs"
          title={`${total} alerte${total > 1 ? "s" : ""}${total > alerts.length ? ` (${alerts.length} plus récentes en orbite)` : ""}`}
        >
          <span className="eyebrow">Posture</span>
          <span className="font-display text-base font-semibold tabular-nums" style={{ color: `var(--${toneVar})` }}>
            {score}
          </span>
          <span className="text-muted">/100</span>
          <span className="font-medium" style={{ color: `var(--${toneVar})` }}>· {postureLabel(score)}</span>
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <ThreatReactor
          alerts={alerts}
          posture={tone}
          criticals={criticals}
          highlightId={highlightId}
          onOrbHover={onOrbHover}
          onSelect={onSelect}
        />

        {/* HUD : légende des orbites (cliquable -> alertes filtrées) */}
        <div className="absolute inset-x-3 bottom-2.5 flex flex-wrap gap-1.5">
          {SEVERITIES.map((s) => {
            const n = bySeverity[s.key] ?? 0;
            return (
              <Link
                key={s.key}
                href={`/dashboard/alerts?severity=${s.key}`}
                className={`flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-2 py-0.5 text-[11px] backdrop-blur transition hover:border-accent/60 ${n === 0 ? "opacity-40" : ""}`}
              >
                <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: s.color }} />
                {s.label}
                <span className="font-mono tabular-nums">{n}</span>
              </Link>
            );
          })}
        </div>
      </div>

      {hover && (
        <HoverTip hover={hover} tipRef={tip}>
          <div className="flex items-center gap-2">
            <SeverityBadge severity={hover.alert.severity} />
            <span className="font-mono tabular-nums text-muted">risque {hover.alert.risk_score}</span>
          </div>
          <p className="mt-1 font-medium">{hover.alert.rule_title}</p>
          {hover.alert.mitre && <p className="font-mono text-accent">{hover.alert.mitre}</p>}
          <p className="mt-0.5 text-[10px] text-muted">Clic : ouvrir l’alerte</p>
        </HoverTip>
      )}
    </div>
  );
}
