"use client";

import { useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import type { AppGroup } from "@/lib/apps";
import { fmtBytes, loadTone, machineLoad } from "@/lib/host";
import { buildLineage } from "@/lib/lineage";
import type { TreeNode } from "@/lib/proctree";
import { ScenePoster } from "@/components/three/scene-poster";
import type { LineageHover } from "@/components/three/lineage-graph";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "./panel-shell";

const LineageGraph = dynamic(() => import("@/components/three/lineage-graph"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/lineage_poster.png" />,
});

const byKey = (h: LineageHover) => h.key;

interface LineagePanelProps {
  app: AppGroup | null;
  focus: TreeNode | null;
  cpuCount: number;
  onSelect: (pid: number) => void;
  className?: string;
}

/** Filiation de l'application sélectionnée : qui l'a lancée, ce qu'elle lance. */
export function LineagePanel({ app, focus, cpuCount, onSelect, className }: LineagePanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<LineageHover>(panel, byKey);
  const lineage = useMemo(() => (app ? buildLineage(app, focus) : null), [app, focus]);
  const hovered = hover ? lineage?.nodes.find((n) => n.key === hover.key) : undefined;
  const hp = hovered?.node?.proc;
  const load = hp ? machineLoad(hp.cpu_percent, cpuCount) : 0;

  return (
    <PanelShell
      panelRef={panel}
      title={app ? `Lignée · ${app.name}` : "Lignée"}
      className={className}
      aside={
        <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted md:flex">
          <Dot color="var(--accent)" label="l'application" />
          <Dot color="#22d3ee" label="possède la fenêtre" ring />
          <Dot color="var(--warn)" label="indice" />
          <span>taille = mémoire · éclat = CPU</span>
        </span>
      }
    >
      {lineage ? (
        <LineageGraph lineage={lineage} cpuCount={cpuCount} focus={focus?.proc.pid ?? null} onHover={onHover} onSelect={onSelect} />
      ) : (
        <p className="grid h-full place-items-center text-xs text-muted">Chargement des processus…</p>
      )}
      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          {hp ? (
            <>
              <span className="font-medium">{hp.name ?? "—"}</span>
              <span className="ml-2 font-mono text-muted">PID {hp.pid}</span>
              <p className="mt-0.5 font-mono tabular-nums">
                CPU <span style={{ color: `var(--${loadTone(load)})` }}>{load.toFixed(1)} %</span> · {hp.rss !== null ? fmtBytes(hp.rss) : `${hp.memory_percent} %`}
                {(hp.windows ?? 0) > 0 && <span style={{ color: "#22d3ee" }}> · fenêtre</span>}
              </p>
              <p className="mt-0.5 text-[10px] text-muted">Clic : inspecter{hovered.inApp ? "" : " (change d'application)"}</p>
            </>
          ) : (
            <span className="text-muted">+{hovered.overflow} autres processus non affichés</span>
          )}
        </HoverTip>
      )}
    </PanelShell>
  );
}

function Dot({ color, label, ring = false }: { color: string; label: string; ring?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2 w-2 rounded-full" style={ring ? { boxShadow: `0 0 0 1.5px ${color}` } : { backgroundColor: color }} /> {label}
    </span>
  );
}
