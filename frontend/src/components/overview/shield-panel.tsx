"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { Posture } from "@/lib/api";
import { LEVEL_VAR, TONE_VAR } from "@/lib/posture";
import { ScenePoster } from "@/components/three/scene-poster";
import type { ShieldHover } from "@/components/three/aegis-shield";
import { HoverTip, usePanelHover } from "./hover-tip";
import { PillarIcon } from "./pillar-icon";

const AegisShield = dynamic(() => import("@/components/three/aegis-shield"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/aegis_poster.png" />,
});

const hoverKey = (h: ShieldHover) => h.pillar;

/** Anneau de score (0-100) coloré selon le verdict. */
function ScoreRing({ score, tone }: { score: number | null; tone: string }) {
  const r = 20;
  const len = 2 * Math.PI * r;
  const v = score ?? 0;
  return (
    <div className="relative h-12 w-12 shrink-0">
      <svg viewBox="0 0 48 48" className="h-full w-full -rotate-90" aria-hidden="true">
        <circle cx="24" cy="24" r={r} fill="none" stroke="var(--line)" strokeWidth="4" />
        <circle cx="24" cy="24" r={r} fill="none" stroke={`var(--${tone})`} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${(v / 100) * len} ${len}`} className="transition-all duration-700" />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center font-mono text-sm font-semibold tabular-nums">{score ?? "—"}</span>
    </div>
  );
}

/** Le bouclier du poste : 5 pétales = 5 piliers ; une brèche = un point faible. */
export function ShieldPanel({ posture, className = "" }: { posture: Posture | null; className?: string }) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<ShieldHover>(panel, hoverKey);
  const pillars = posture?.pillars ?? [];
  const threats = pillars.find((p) => p.key === "threats")?.findings ?? [];
  const hovered = hover ? pillars.find((p) => p.key === hover.pillar) : undefined;
  const tone = posture ? TONE_VAR[posture.tone] : "muted";

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-3 border-b border-line px-4 py-2">
        <ScoreRing score={posture?.score ?? null} tone={tone} />
        <div className="min-w-0">
          <p className="eyebrow">Bouclier du poste</p>
          <p className="font-display text-base font-semibold" style={{ color: `var(--${tone})` }}>
            {posture?.verdict ?? "…"}
          </p>
        </div>
        <p className="ml-auto max-w-[11rem] text-right text-[11px] leading-snug text-muted">Chaque pétale est un pilier ; une brèche signale un point faible.</p>
      </div>

      <div className="relative min-h-0 flex-1">
        {/* Monté tout de suite (même sans données), comme les autres scènes : créer un contexte
            WebGL après les autres empêchait leur affichage dans Chromium. */}
        <AegisShield
          pillars={pillars}
          tone={posture?.tone ?? "unknown"}
          threats={threats}
          selected={hover?.pillar ?? null}
          onHover={onHover}
          onSelect={(key) => router.push(pillars.find((p) => p.key === key)?.href ?? "/dashboard")}
        />
      </div>

      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="flex items-center gap-1.5 font-medium" style={{ color: `var(--${TONE_VAR[hovered.tone]})` }}>
            <PillarIcon pillar={hovered.key} className="h-3.5 w-3.5" />
            {hovered.label}
            <span className="ml-auto font-mono tabular-nums">{hovered.score ?? "—"}/100</span>
          </p>
          <p className="mt-1">{hovered.headline}</p>
          <ul className="mt-1.5 space-y-1">
            {hovered.findings.slice(0, 4).map((f) => (
              <li key={f.id} className="flex gap-1.5 text-[11px]">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `var(--${LEVEL_VAR[f.level]})` }} />
                <span className="min-w-0">
                  <span className="block truncate">{f.title}</span>
                  <span className="block truncate text-[10px] text-muted">source : {f.source}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-[10px] text-muted">Clic : agir sur ce pilier</p>
        </HoverTip>
      )}
    </div>
  );
}
