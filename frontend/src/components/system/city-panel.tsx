"use client";

import { useRef } from "react";
import dynamic from "next/dynamic";
import type { ProcInfo } from "@/lib/api";
import { loadTone, machineLoad } from "@/lib/host";
import { ScenePoster } from "@/components/three/scene-poster";
import type { ProcessHover } from "@/components/three/process-city";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "./panel-shell";

const ProcessCity = dynamic(() => import("@/components/three/process-city"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/city_poster.png" />,
});

const byPid = (h: ProcessHover) => h.pid;

interface CityPanelProps {
  processes: ProcInfo[];
  cpuCount: number;
  selected: number | null;
  highlight: number | null;
  onHighlight: (pid: number | null) => void;
  onSelect: (pid: number | null) => void;
  className?: string;
}

/** Ville des processus : le survol d'un bâtiment surligne sa ligne dans la liste, et inversement. */
export function CityPanel({ processes, cpuCount, selected, highlight, onHighlight, onSelect, className }: CityPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<ProcessHover>(panel, byPid);
  const proc = hover ? processes.find((p) => p.pid === hover.pid) : undefined;
  const load = proc ? machineLoad(proc.cpu_percent, cpuCount) : 0;

  return (
    <PanelShell
      panelRef={panel}
      title="Ville des processus"
      className={className}
      aside={
        <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted sm:flex">
          <span>emprise = mémoire</span>
          <span>hauteur = CPU (log)</span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-muted/60" /> chemin inaccessible
          </span>
        </span>
      }
    >
      <ProcessCity
        processes={processes}
        cpuCount={cpuCount}
        selected={selected}
        highlight={highlight}
        onHover={(h) => {
          onHover(h);
          onHighlight(h?.pid ?? null);
        }}
        onSelect={onSelect}
      />
      {hover && proc && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-mono font-medium">{proc.name ?? "—"}</span>
          <span className="ml-2 text-muted">PID {proc.pid}</span>
          <p className="mt-0.5 font-mono tabular-nums">
            CPU <span style={{ color: `var(--${loadTone(load)})` }}>{load.toFixed(1)} %</span> · RAM {proc.memory_percent.toFixed(1)} %
          </p>
          <p className="mt-0.5 text-[10px] text-muted">Clic : inspecter</p>
        </HoverTip>
      )}
    </PanelShell>
  );
}
