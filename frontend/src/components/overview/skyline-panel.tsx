"use client";

import { useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { SeverityBadge } from "@/components/ui";
import { ScenePoster } from "@/components/three/scene-poster";
import type { SkylineHover } from "@/components/three/attack-skyline";
import { laneOf, TACTICS, type SkylineTechnique } from "@/lib/mitre";
import { HoverTip, usePanelHover } from "./hover-tip";

const AttackSkyline = dynamic(() => import("@/components/three/attack-skyline"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/skyline_poster.png" />,
});

const skyKey = (h: SkylineHover) => (h.kind === "tech" ? `t:${h.tech.id}` : `l:${h.lane}`);

interface SkylinePanelProps {
  techniques: SkylineTechnique[];
  className?: string;
}

/** Widget MITRE ATT&CK : tours par technique, couloirs par tactique (angles morts visibles). */
export function SkylinePanel({ techniques, className = "" }: SkylinePanelProps) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<SkylineHover>(panel, skyKey);
  const tactics = new Set(techniques.map((t) => laneOf(t.tactic))).size;
  const openTechnique = useCallback(
    (t: SkylineTechnique) => router.push(`/dashboard/alerts?mitre=${encodeURIComponent(t.id)}`),
    [router],
  );
  const laneTechs = hover?.kind === "lane" ? techniques.filter((t) => laneOf(t.tactic) === hover.lane) : [];

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">MITRE ATT&amp;CK</span>
        <span className="font-mono text-xs tabular-nums text-muted">
          {techniques.length} technique{techniques.length > 1 ? "s" : ""} · {tactics}/14 tactiques
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <AttackSkyline techniques={techniques} onHover={onHover} onSelect={openTechnique} />
        {techniques.length === 0 && (
          <p className="pointer-events-none absolute inset-x-0 top-4 text-center text-xs text-muted">
            Aucune technique détectée pour l’instant.
          </p>
        )}
      </div>

      {hover?.kind === "tech" && (
        <HoverTip hover={hover} tipRef={tip}>
          <p>
            <span className="font-mono text-accent">{hover.tech.id}</span>
            {hover.tech.name && <span className="ml-1.5 font-medium">{hover.tech.name}</span>}
          </p>
          <p className="text-muted">
            {hover.tech.count} alerte{hover.tech.count > 1 ? "s" : ""} · {hover.tech.tactic_fr ?? TACTICS[laneOf(hover.tech.tactic)].label}
          </p>
          {hover.tech.worst && (
            <div className="mt-1 flex items-center gap-1.5">
              <span className="text-[10px] text-muted">sévérité max</span>
              <SeverityBadge severity={hover.tech.worst} />
            </div>
          )}
          <p className="mt-0.5 text-[10px] text-muted">Clic : alertes liées</p>
        </HoverTip>
      )}
      {hover?.kind === "lane" && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-medium">{TACTICS[hover.lane].label}</p>
          <p className={laneTechs.length ? "text-accent" : "text-muted"}>
            {laneTechs.length
              ? `${laneTechs.length} technique${laneTechs.length > 1 ? "s" : ""} détectée${laneTechs.length > 1 ? "s" : ""}`
              : "Aucune détection sur cette tactique"}
          </p>
        </HoverTip>
      )}
    </div>
  );
}
