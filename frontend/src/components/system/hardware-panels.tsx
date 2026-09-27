"use client";

import { useMemo, useRef } from "react";
import dynamic from "next/dynamic";
import type { Metrics } from "@/lib/api";
import { fmtBytes, loadTone, mapCores } from "@/lib/host";
import { ScenePoster } from "@/components/three/scene-poster";
import type { CoreHover } from "@/components/three/cpu-chip";
import type { ChipHover } from "@/components/three/ram-module";
import type { TankHover } from "@/components/three/storage-tanks";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "./panel-shell";

// three.js n'est chargé que côté navigateur, sur les pages qui l'utilisent.
const CpuChip = dynamic(() => import("@/components/three/cpu-chip"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/cpu_widget_poster.png" />,
});
const RamModule = dynamic(() => import("@/components/three/ram-module"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/ram_poster.png" />,
});
const StorageTanks = dynamic(() => import("@/components/three/storage-tanks"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/storage_poster.png" />,
});

const RAM_CHIPS = 8; // = RAM_CHIPS de ram-module (non importé : il tirerait three.js dans ce module)
const byIndex = (h: { index: number }) => h.index;
const pct = (v: number) => `${Math.round(v)} %`;

/** Processeur : la puce 3D (un cœur lumineux par cœur logique), anneau = charge globale. */
export function CpuPanel({ metrics, className }: { metrics: Metrics | null; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<CoreHover>(panel, byIndex);
  const cores = useMemo(() => mapCores(metrics?.cpu_per_core, 12), [metrics?.cpu_per_core]);
  const tone = metrics ? loadTone(metrics.cpu_percent) : undefined;
  const peak = cores.reduce<{ label: string; value: number } | null>(
    (best, c) => (c.value !== null && (best === null || c.value > best.value) ? { label: c.label, value: c.value } : best),
    null,
  );
  const hovered = hover ? cores[hover.index] : null;

  return (
    <PanelShell
      panelRef={panel}
      title="Processeur"
      value={metrics ? pct(metrics.cpu_percent) : "—"}
      tone={tone}
      className={className}
      footer={
        <span className="flex justify-between gap-2">
          <span>{metrics?.cpu_count ?? "—"} cœurs logiques</span>
          {peak && (
            <span>
              pic : {peak.label} <span className="font-mono tabular-nums" style={{ color: `var(--${loadTone(peak.value)})` }}>{pct(peak.value)}</span>
            </span>
          )}
        </span>
      }
    >
      <CpuChip
        cores={cores}
        posture={tone === "accent" || tone === undefined ? "ok" : tone}
        criticalAlerts={tone === "critical" ? 1 : 0}
        netBytesPerSec={(metrics?.net_up ?? 0) + (metrics?.net_down ?? 0)}
        onCoreHover={onHover}
      />
      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-medium">{hovered.label}</span>
          <span className="ml-2 font-mono tabular-nums" style={{ color: hovered.value === null ? "var(--muted)" : `var(--${loadTone(hovered.value)})` }}>
            {hovered.value === null ? "inactif" : pct(hovered.value)}
          </span>
        </HoverTip>
      )}
    </PanelShell>
  );
}

/** Mémoire : barrette 3D, une puce par huitième de RAM. */
export function RamPanel({ metrics, className }: { metrics: Metrics | null; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<ChipHover>(panel, byIndex);
  const percent = metrics?.ram_percent ?? null;
  const slice = metrics ? metrics.ram_total / RAM_CHIPS : 0;
  const fill = hover && percent !== null ? Math.min(1, Math.max(0, (percent / 100) * RAM_CHIPS - hover.index)) : 0;

  return (
    <PanelShell
      panelRef={panel}
      title="Mémoire"
      value={percent === null ? "—" : pct(percent)}
      tone={percent === null ? undefined : loadTone(percent)}
      className={className}
      footer={
        <span className="flex justify-between gap-2">
          <span className="font-mono tabular-nums">{metrics ? `${fmtBytes(metrics.ram_used)} / ${fmtBytes(metrics.ram_total)}` : "—"}</span>
          <span>libre : <span className="font-mono tabular-nums text-foreground">{metrics ? fmtBytes(metrics.ram_total - metrics.ram_used) : "—"}</span></span>
        </span>
      }
    >
      <RamModule percent={percent} onChipHover={onHover} />
      {hover && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-medium">Puce {hover.index + 1}</span>
          <span className="ml-2 text-muted">
            {(hover.index * 100) / RAM_CHIPS}–{((hover.index + 1) * 100) / RAM_CHIPS} % de la RAM
          </span>
          <p className="mt-0.5 font-mono tabular-nums">
            {fill === 0 ? "libre" : fill === 1 ? "pleine" : `remplie à ${Math.round(fill * 100)} %`} · {fmtBytes(slice)}
          </p>
        </HoverTip>
      )}
    </PanelShell>
  );
}

/** Stockage : un réservoir de verre par disque, rempli au niveau d'occupation. */
export function StoragePanel({ metrics, className }: { metrics: Metrics | null; className?: string }) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<TankHover>(panel, byIndex);
  const disks = metrics?.disks ?? [];
  const used = disks.reduce((s, d) => s + d.used, 0);
  const total = disks.reduce((s, d) => s + d.total, 0);
  const disk = hover ? disks[hover.index] : null;

  return (
    <PanelShell
      panelRef={panel}
      title="Stockage"
      value={total > 0 ? pct((used / total) * 100) : "—"}
      tone={total > 0 ? loadTone((used / total) * 100) : undefined}
      className={className}
      footer={
        <span className="flex justify-between gap-2">
          <span>{disks.length} volume{disks.length > 1 ? "s" : ""}</span>
          <span className="font-mono tabular-nums">{total > 0 ? `${fmtBytes(used)} / ${fmtBytes(total)}` : "—"}</span>
        </span>
      }
    >
      {metrics && <StorageTanks disks={disks} onTankHover={onHover} />}
      {hover && disk && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-mono font-medium">{disk.mount}</span>
          <span className="ml-2 font-mono tabular-nums" style={{ color: `var(--${loadTone(disk.percent)})` }}>
            {pct(disk.percent)}
          </span>
          <p className="mt-0.5 font-mono tabular-nums">
            {fmtBytes(disk.used)} / {fmtBytes(disk.total)} · libre {fmtBytes(disk.total - disk.used)}
          </p>
        </HoverTip>
      )}
    </PanelShell>
  );
}
