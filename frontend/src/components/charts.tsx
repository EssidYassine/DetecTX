"use client";

import { useEffect, useId, useState } from "react";
import { shortChannel } from "@/components/ui";

/** Mini-graphe (sparkline) pour cartes KPI. */
export function Sparkline({ data, tone = "accent", height = 36 }: { data: number[]; tone?: string; height?: number }) {
  const gid = useId();
  const w = 100;
  const h = height;
  const max = Math.max(1, ...data);
  const n = Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [(i / n) * w, h - (v / max) * (h - 3) - 2]);
  const line = "M" + pts.map((p) => `${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" L");
  const area = `${line} L${w},${h} L0,${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
      <defs>
        <linearGradient id={`spark-${gid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={`var(--${tone})`} stopOpacity="0.35" />
          <stop offset="100%" stopColor={`var(--${tone})`} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${gid})`} />
      <path d={line} fill="none" stroke={`var(--${tone})`} strokeWidth="1.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Graphe d'aire interactif (crosshair + tooltip au survol). */
export function AreaChart({
  data, tone = "accent", height = 190, showAxis = true, unit = "évts",
}: { data: number[]; tone?: string; height?: number; showAxis?: boolean; unit?: string }) {
  const gid = useId();
  const [mounted, setMounted] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => setMounted(true), []);
  const w = 600, h = height, pad = 8;
  const max = Math.max(1, ...data);
  const n = Math.max(1, data.length - 1);
  const pts = data.map((v, i) => [pad + (i / n) * (w - 2 * pad), h - pad - (v / max) * (h - 3 * pad)]);
  const line = "M" + pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" L");
  const area = `${line} L${w - pad},${h - pad} L${pad},${h - pad} Z`;
  const last = pts[pts.length - 1];

  function onMove(e: React.MouseEvent<HTMLDivElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    setHover(Math.max(0, Math.min(data.length - 1, Math.round(((e.clientX - r.left) / r.width) * n))));
  }
  const hp = hover != null ? pts[hover] : null;
  const hpct = hp ? (hp[0] / w) * 100 : 0;

  return (
    <div className="relative p-5" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full" style={{ height }}>
        <defs>
          <linearGradient id={`area-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={`var(--${tone})`} stopOpacity="0.28" />
            <stop offset="100%" stopColor={`var(--${tone})`} stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={pad} y1={h * f} x2={w - pad} y2={h * f} stroke="var(--line)" strokeWidth="1" opacity="0.5" />
        ))}
        <path d={area} fill={`url(#area-${gid})`} style={{ opacity: mounted ? 1 : 0, transition: "opacity 0.6s" }} />
        <path d={line} fill="none" stroke={`var(--${tone})`} strokeWidth="2" vectorEffect="non-scaling-stroke"
          strokeLinejoin="round" strokeLinecap="round"
          style={{ strokeDasharray: 2000, strokeDashoffset: mounted ? 0 : 2000, transition: "stroke-dashoffset 1s ease-out" }} />
        {hp && <line x1={hp[0]} y1={pad} x2={hp[0]} y2={h - pad} stroke={`var(--${tone})`} strokeWidth="1" opacity="0.6" vectorEffect="non-scaling-stroke" />}
        {hp ? (
          <circle cx={hp[0]} cy={hp[1]} r="4.5" fill={`var(--${tone})`} stroke="var(--surface)" strokeWidth="2" />
        ) : (
          last && <circle cx={last[0]} cy={last[1]} r="3.5" fill={`var(--${tone})`} />
        )}
      </svg>
      {hp && (
        <div className="pointer-events-none absolute top-2 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-line bg-surface px-2.5 py-1 text-xs shadow-lg"
          style={{ left: `${Math.min(90, Math.max(10, hpct))}%` }}>
          <span className="font-mono font-semibold tabular-nums" style={{ color: `var(--${tone})` }}>{data[hover!]}</span> {unit}
        </div>
      )}
      {showAxis && (
        <div className="mt-2 flex justify-between px-1 text-[10px] text-muted">
          <span>-24h</span><span>-18h</span><span>-12h</span><span>-6h</span><span>maintenant</span>
        </div>
      )}
    </div>
  );
}

export interface Segment {
  label: string;
  value: number;
  color: string; // CSS var, ex "var(--critical)"
}

/** Donut interactif : survol met en avant, clic pour filtrer. */
export function DonutChart({
  segments,
  size = 168,
  thickness = 20,
  onSegmentClick,
}: {
  segments: Segment[];
  size?: number;
  thickness?: number;
  onSegmentClick?: (label: string) => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  useEffect(() => setMounted(true), []);

  const total = segments.reduce((s, x) => s + x.value, 0);
  const radius = (size - thickness) / 2;
  const circ = 2 * Math.PI * radius;
  const c = size / 2;
  const active = hover ? segments.find((s) => s.label === hover) : null;
  const clickable = !!onSegmentClick;

  let offset = 0;
  return (
    <div className="flex flex-wrap items-center justify-center gap-8 p-5">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={c} cy={c} r={radius} fill="none" stroke="var(--surface-2)" strokeWidth={thickness} />
          {total > 0 &&
            segments.map((s) => {
              const frac = s.value / total;
              const len = mounted ? frac * circ : 0;
              const isHover = hover === s.label;
              const el = (
                <circle
                  key={s.label}
                  cx={c}
                  cy={c}
                  r={radius}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={isHover ? thickness + 5 : thickness}
                  strokeDasharray={`${len} ${circ - len}`}
                  strokeDashoffset={-offset}
                  strokeLinecap="butt"
                  onMouseEnter={() => setHover(s.label)}
                  onMouseLeave={() => setHover(null)}
                  onClick={onSegmentClick ? () => onSegmentClick(s.label) : undefined}
                  style={{
                    cursor: clickable ? "pointer" : "default",
                    opacity: hover && !isHover ? 0.4 : 1,
                    transition: "stroke-dasharray 0.9s cubic-bezier(0.16,1,0.3,1), stroke-width 0.2s, opacity 0.2s",
                  }}
                />
              );
              offset += mounted ? frac * circ : 0;
              return el;
            })}
        </svg>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-3xl font-semibold tabular-nums" style={active ? { color: active.color } : undefined}>
            {active ? active.value : total}
          </span>
          <span className="text-xs capitalize text-muted">{active ? active.label : "alertes"}</span>
        </div>
      </div>

      <ul className="space-y-2 text-sm">
        {segments.map((s) => (
          <li
            key={s.label}
            onMouseEnter={() => setHover(s.label)}
            onMouseLeave={() => setHover(null)}
            onClick={onSegmentClick ? () => onSegmentClick(s.label) : undefined}
            className={`flex items-center gap-2 rounded-md px-2 py-0.5 transition ${clickable ? "cursor-pointer hover:bg-surface-2" : ""}`}
            style={{ opacity: hover && hover !== s.label ? 0.5 : 1 }}
          >
            <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} />
            <span className="capitalize text-muted">{s.label}</span>
            <span className="ml-auto font-mono tabular-nums">{s.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Jauge radiale 270° — couleur automatique selon la charge. */
export function Gauge({
  value,
  label,
  unit = "%",
  sub,
  tone,
  size = 148,
}: {
  value: number;
  label: string;
  unit?: string;
  sub?: string;
  tone?: string;
  size?: number;
}) {
  const v = Math.max(0, Math.min(100, value));
  const auto = v >= 90 ? "critical" : v >= 70 ? "warn" : tone || "accent";
  const stroke = 11;
  const r = (size - stroke) / 2 - 6;
  const c = 2 * Math.PI * r;
  const arc = 0.75;
  const cx = size / 2;
  return (
    <div className="relative flex flex-col items-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-[135deg]">
        <circle cx={cx} cy={cx} r={r} fill="none" stroke="var(--surface-2)" strokeWidth={stroke}
          strokeDasharray={`${c * arc} ${c}`} strokeLinecap="round" />
        <circle cx={cx} cy={cx} r={r} fill="none" stroke={`var(--${auto})`} strokeWidth={stroke}
          strokeDasharray={`${c * arc * (v / 100)} ${c}`} strokeLinecap="round"
          style={{ transition: "stroke-dasharray 0.5s cubic-bezier(0.16,1,0.3,1), stroke 0.4s" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-3xl font-semibold tabular-nums" style={{ color: `var(--${auto})` }}>
          {Math.round(v)}
          <span className="text-lg text-muted">{unit}</span>
        </span>
        <span className="eyebrow mt-1">{label}</span>
        {sub && <span className="mt-0.5 text-xs text-muted">{sub}</span>}
      </div>
    </div>
  );
}

/** Barres horizontales interactives — survol + clic pour drill-down. */
export function BarChart({
  data,
  tone = "accent",
  onBarClick,
  short = true,
}: {
  data: Record<string, number>;
  tone?: string;
  onBarClick?: (key: string) => void;
  short?: boolean;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map(([, v]) => v));
  const clickable = !!onBarClick;

  return (
    <div className="space-y-1 p-3">
      {entries.map(([key, val]) => (
        <div
          key={key}
          onClick={onBarClick ? () => onBarClick(key) : undefined}
          className={`rounded-lg px-2 py-1.5 transition ${clickable ? "cursor-pointer hover:bg-surface-2" : ""}`}
        >
          <div className="mb-1 flex items-center justify-between text-sm">
            <span className="truncate pr-2 text-muted">{short ? shortChannel(key) : key}</span>
            <span className="font-mono tabular-nums">{val}</span>
          </div>
          <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
            <div
              className="h-full rounded-full"
              style={{
                width: mounted ? `${(val / max) * 100}%` : "0%",
                background: `linear-gradient(90deg, color-mix(in srgb, var(--${tone}) 55%, transparent), var(--${tone}))`,
                transition: "width 0.8s cubic-bezier(0.16,1,0.3,1)",
                boxShadow: `0 0 12px -2px var(--${tone})`,
              }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
