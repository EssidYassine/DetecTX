"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import type { NetDevice } from "@/lib/api";
import { displayName, isPresent, RISK_LABEL, RISK_TONE, STATUS_LABEL } from "@/lib/sonar";
import { fmtAgo } from "@/lib/time";
import { ScenePoster } from "@/components/three/scene-poster";
import type { SonarHover } from "@/components/three/sonar";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";

const Sonar = dynamic(() => import("@/components/three/sonar"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/sonar_poster.png" />,
});

const hoverKey = (h: SonarHover) => h.id;

interface SonarPanelProps {
  devices: NetDevice[];
  now: number;
  selected: string | null;
  scanning: boolean;
  onSelect: (id: string | null) => void;
  className?: string;
}

/** La coupole : où sont les appareils, lesquels sont nouveaux, lesquels sont exposés. */
export function SonarPanel({ devices, now, selected, scanning, onSelect, className = "" }: SonarPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<SonarHover>(panel, hoverKey);
  const hovered = hover ? devices.find((d) => d.id === hover.id) : undefined;

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <p className="text-xs font-medium">Le Sonar</p>
        {scanning && <span className="animate-pulse rounded-full bg-accent/15 px-2 py-0.5 text-[10px] text-accent">scan en cours</span>}
        <span className="ml-auto text-[10px] text-muted">rien de votre réseau ne sort de ce PC</span>
      </div>
      <div className="relative min-h-0 flex-1">
        <Sonar devices={devices} now={now} selected={selected} scanning={scanning} onHover={onHover} onSelect={onSelect} />
        <p className="pointer-events-none absolute left-3 top-2.5 max-w-[13rem] text-[10px] leading-snug text-muted">
          Chaque écho est un appareil de votre réseau. Près de la box : ceux que vous avez approuvés ; sur l&apos;anneau ambre : les nouveaux. Plus le mât est haut, plus l&apos;appareil est exposé.
        </p>
        <ul className="pointer-events-none absolute bottom-2 left-3 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted" aria-label="Légende">
          <li className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-accent" /> présent</li>
          <li className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-warn" /> nouveau / exposé</li>
          <li className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-critical" /> à traiter</li>
          <li className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted opacity-50" /> absent</li>
        </ul>
      </div>
      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-medium">{displayName(hovered)}</p>
          <p className="text-muted">
            {hovered.kind_label} · {hovered.ip}
          </p>
          <p className="mt-1">
            {hovered.gateway_mismatch ? (
              <span className="text-critical">Répond à la place de la box</span>
            ) : (
              <>
                {STATUS_LABEL[hovered.status]} ·{" "}
                <span style={{ color: `var(--${RISK_TONE[hovered.risk]})` }}>
                  exposition {RISK_LABEL[hovered.risk].toLowerCase()}
                  {hovered.open_ports ? ` (${hovered.open_ports} port${hovered.open_ports > 1 ? "s" : ""})` : ""}
                </span>
              </>
            )}
          </p>
          <p className="text-muted">{isPresent(hovered, now) ? "présent" : `vu ${fmtAgo(hovered.last_seen, now)}`}</p>
        </HoverTip>
      )}
    </div>
  );
}
