"use client";

import { useCallback, useRef } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { shortChannel } from "@/components/ui";
import { ScenePoster } from "@/components/three/scene-poster";
import type { BucketHover } from "@/components/three/activity-dial";
import { fmtClock } from "@/lib/time";
import { HoverTip, usePanelHover } from "./hover-tip";

const ActivityDial = dynamic(() => import("@/components/three/activity-dial"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/dial_poster.png" />,
});

const HOUR_MS = 3_600_000;
const bucketKey = (h: BucketHover) => h.bucket;

interface DialPanelProps {
  events: number[];
  alerts: number[];
  now: number;
  events24h: number;
  eventsTotal: number;
  byChannel: Record<string, number>;
  className?: string;
}

/** Widget activité : cadran 24 h (colonnes horaires) + principales sources en HUD. */
export function DialPanel({ events, alerts, now, events24h, eventsTotal, byChannel, className = "" }: DialPanelProps) {
  const router = useRouter();
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onBucketHover, tip] = usePanelHover<BucketHover>(panel, bucketKey);
  const topChannels = Object.entries(byChannel).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const alerts24h = alerts.reduce((s, v) => s + v, 0);

  // Tranche i : [now - (24 - i) h, now - (23 - i) h] ; clic -> événements depuis son début.
  const openBucket = useCallback(
    (bucket: number) => router.push(`/dashboard/events?minutes=${(24 - bucket) * 60}`),
    [router],
  );
  const start = hover ? now - (24 - hover.bucket) * HOUR_MS : 0;

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow whitespace-nowrap">Activité 24 h</span>
        <span
          className="flex items-baseline gap-1.5 whitespace-nowrap font-mono text-xs tabular-nums"
          title={`${eventsTotal} événements collectés au total · ${alerts24h} alerte(s) sur 24 h`}
        >
          <span className="font-display text-base font-semibold text-accent">{events24h}</span>
          <span className="text-muted">évts</span>
          {alerts24h > 0 && <span className="text-critical">· {alerts24h} al.</span>}
        </span>
      </div>

      <div className="relative min-h-0 flex-1">
        <ActivityDial events={events} alerts={alerts} now={now} onBucketHover={onBucketHover} onSelect={openBucket} />

        {topChannels.length > 0 && (
          <div className="absolute inset-x-3 bottom-2.5 flex flex-wrap gap-1.5">
            {topChannels.map(([ch, n]) => (
              <Link
                key={ch}
                href={`/dashboard/events?channel=${encodeURIComponent(ch)}`}
                className="flex items-center gap-1.5 rounded-full border border-line bg-surface/80 px-2 py-0.5 text-[11px] backdrop-blur transition hover:border-accent/60"
                title={ch}
              >
                {shortChannel(ch)}
                <span className="font-mono tabular-nums text-muted">{n}</span>
              </Link>
            ))}
          </div>
        )}
      </div>

      {hover && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-mono font-medium tabular-nums">
            {fmtClock(start)} – {fmtClock(start + HOUR_MS)}
          </p>
          <p>
            <span className="font-mono tabular-nums text-accent">{events[hover.bucket] ?? 0}</span> événements ·{" "}
            <span className="font-mono tabular-nums" style={{ color: (alerts[hover.bucket] ?? 0) > 0 ? "var(--critical)" : undefined }}>
              {alerts[hover.bucket] ?? 0}
            </span>{" "}
            alerte{(alerts[hover.bucket] ?? 0) > 1 ? "s" : ""}
          </p>
          <p className="mt-0.5 text-[10px] text-muted">Clic : événements depuis {fmtClock(start)}</p>
        </HoverTip>
      )}
    </div>
  );
}
