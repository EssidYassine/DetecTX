"use client";

import { useCallback, useMemo, useRef, type ReactNode } from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import type { Metrics } from "@/lib/api";
import { fmtBytes, fmtUptime, loadTone, mapCores, type CoreSlot } from "@/lib/host";
import type { PostureTone } from "@/lib/posture";
import { ScenePoster } from "@/components/three/scene-poster";
import type { CoreHover } from "@/components/three/cpu-chip";
import { SystemControlButtons } from "@/components/system-control";
import { HoverTip, usePanelHover } from "./hover-tip";

// three.js n'est chargé que sur cette page, côté navigateur uniquement.
const CpuChip = dynamic(() => import("@/components/three/cpu-chip"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/cpu_widget_poster.png" />,
});

const coreKey = (h: CoreHover) => h.index;

interface HostPanelProps {
  metrics: Metrics | null;
  posture: PostureTone;
  criticals: number;
  className?: string;
}

/** Widget hôte : jumeau numérique 3D du poste + ressources + contrôle du poste. */
export function HostPanel({ metrics, posture, criticals, className = "" }: HostPanelProps) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onCoreHover, tip] = usePanelHover<CoreHover>(panel, coreKey);
  const cores = useMemo(() => mapCores(metrics?.cpu_per_core, 12), [metrics?.cpu_per_core]);
  const openSystem = useCallback(() => router.push("/dashboard/machines"), [router]);
  const hovered = hover ? cores[hover.index] : null;
  const disk = metrics?.disks?.[0];

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <span className="eyebrow">Hôte</span>
          <span className="truncate font-display font-semibold tracking-wide">{metrics?.hostname ?? "—"}</span>
        </div>
        {/* Priorité d'affichage : CPU / cœurs / uptime partout ; processus et réseau sur grand écran. */}
        <div className="ml-auto hidden items-baseline gap-x-4 whitespace-nowrap text-xs md:flex">
          <Stat label="CPU" value={metrics ? `${metrics.cpu_percent}%` : "—"} tone={metrics ? loadTone(metrics.cpu_percent) : undefined} />
          <Stat label="Cœurs" value={metrics?.cpu_count ?? "—"} />
          <Stat label="Uptime" value={metrics ? fmtUptime(metrics.uptime_seconds) : "—"} />
          <span className="hidden 2xl:inline-flex">
            <Stat label="Proc." value={metrics?.process_count ?? "—"} />
          </span>
          <span className="hidden 2xl:inline-flex">
            <Stat label="Réseau" value={metrics ? `↑ ${fmtBytes(metrics.net_up)}/s · ↓ ${fmtBytes(metrics.net_down)}/s` : "—"} />
          </span>
        </div>
        <SystemControlButtons />
      </div>

      <div className="relative min-h-0 flex-1">
        <CpuChip
          cores={cores}
          posture={posture}
          criticalAlerts={criticals}
          netBytesPerSec={(metrics?.net_up ?? 0) + (metrics?.net_down ?? 0)}
          onCoreHover={onCoreHover}
          onSelect={openSystem}
        />
      </div>

      <div className="border-t border-line px-4 py-2.5">
        <div className="flex items-end gap-4">
          <CoreBars cores={cores} active={hover?.index ?? null} />
          <MiniBar label="RAM" percent={metrics?.ram_percent} detail={metrics ? `${fmtBytes(metrics.ram_used)} / ${fmtBytes(metrics.ram_total)}` : ""} />
          <MiniBar label={`Disque ${disk?.mount ?? ""}`} percent={disk?.percent} detail={disk ? `${fmtBytes(disk.used)} / ${fmtBytes(disk.total)}` : ""} />
        </div>
      </div>

      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-medium">{hovered.label}</span>
          <span className="ml-2 font-mono tabular-nums" style={{ color: hovered.value === null ? "var(--muted)" : `var(--${loadTone(hovered.value)})` }}>
            {hovered.value === null ? "inactif" : `${hovered.value.toFixed(0)} %`}
          </span>
          <p className="mt-0.5 text-[10px] text-muted">Clic : détail du système</p>
        </HoverTip>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono tabular-nums" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
    </span>
  );
}

/** Mini-barres par cœur : équivalent textuel/accessible de la puce 3D. */
function CoreBars({ cores, active }: { cores: CoreSlot[]; active: number | null }) {
  const text = (c: CoreSlot) => `${c.label} · ${c.value === null ? "inactif" : `${c.value.toFixed(0)} %`}`;
  return (
    <div className="min-w-0 flex-1">
      <div className="flex h-7 items-end gap-1" aria-hidden="true">
        {cores.map((c, i) => (
          <div key={i} className="flex h-full flex-1 items-end overflow-hidden rounded-sm bg-surface-2" title={text(c)}>
            <div
              className="w-full rounded-sm transition-all duration-500"
              style={{
                height: `${Math.max(4, c.value ?? 0)}%`,
                backgroundColor: c.value === null ? "var(--line)" : `var(--${loadTone(c.value)})`,
                opacity: active === null || active === i ? 1 : 0.4,
              }}
            />
          </div>
        ))}
      </div>
      <ul className="sr-only">
        {cores.map((c, i) => (
          <li key={i}>{text(c)}</li>
        ))}
      </ul>
    </div>
  );
}

function MiniBar({ label, percent, detail }: { label: string; percent?: number; detail: string }) {
  const v = percent ?? 0;
  const color = `var(--${loadTone(v)})`;
  return (
    <div className="hidden w-40 shrink-0 sm:block" title={detail}>
      <div className="mb-1 flex items-baseline justify-between">
        <span className="eyebrow">{label}</span>
        <span className="font-mono text-xs tabular-nums" style={percent === undefined ? undefined : { color }}>
          {percent === undefined ? "—" : `${v.toFixed(0)} %`}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${v}%`, backgroundColor: color }} />
      </div>
    </div>
  );
}
