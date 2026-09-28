"use client";

import { useCallback, useState } from "react";
import { fetchAlertCases, fetchFeed, fetchMetrics, fetchOverview, fetchPosture, type AlertCase, type FeedItem, type Metrics, type Overview, type Posture } from "@/lib/api";
import { sceneTone } from "@/lib/posture";
import { usePolling } from "@/lib/use-polling";
import { HeroBand } from "@/components/overview/hero-band";
import { HostPanel } from "@/components/overview/host-panel";
import { ShieldPanel } from "@/components/overview/shield-panel";
import { PrioritiesPanel } from "@/components/overview/priorities-panel";
import { DialPanel } from "@/components/overview/dial-panel";
import { LiveFeed } from "@/components/overview/live-feed";

const EMPTY_SERIES: number[] = Array(24).fill(0);
const POSTURE_MS = 15_000;
const METRICS_MS = 3_000;
const FEED_MS = 15_000;

/**
 * Centre de supervision : répondre en 5 secondes à « suis-je protégé ? », « que dois-je
 * faire ? » et « que se passe-t-il ? ». Tout tient dans l'écran (pas de défilement sur desktop).
 * La posture est calculée par le serveur (5 piliers, constats sourcés) : GET /stats/posture.
 */
export default function OverviewPage() {
  const [posture, setPosture] = useState<Posture | null>(null);
  const [ov, setOv] = useState<Overview | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [cases, setCases] = useState<AlertCase[] | null>(null);
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const loadPosture = useCallback(async () => {
    const [p, o] = await Promise.all([fetchPosture().catch(() => null), fetchOverview().catch(() => null)]);
    if (p) setPosture(p);
    if (o) setOv(o);
    setNow(Date.now());
  }, []);
  const loadMetrics = useCallback(async () => {
    const m = await fetchMetrics().catch(() => null);
    if (m) setMetrics(m);
  }, []);
  const loadFeed = useCallback(async () => {
    const [c, f] = await Promise.all([fetchAlertCases({}).catch(() => null), fetchFeed(60 * 24, 30).catch(() => null)]);
    if (c) setCases([...c.cases].sort((a, b) => b.last_seen.localeCompare(a.last_seen)).slice(0, 12));
    if (f) setFeed(f);
  }, []);

  usePolling(loadPosture, POSTURE_MS);
  usePolling(loadMetrics, METRICS_MS);
  usePolling(loadFeed, FEED_MS);

  const openCritical = posture?.pillars.find((p) => p.key === "threats")?.findings.filter((f) => f.level === "critical").length ?? 0;

  return (
    <>
      <HeroBand posture={posture} hostname={metrics?.hostname ?? null} now={now} />

      {/* Desktop : la grille remplit exactement l'écran sous le bandeau ; seules les listes défilent. */}
      <div className="grid gap-4 lg:h-[calc(100dvh-17rem)] lg:min-h-[460px] lg:grid-cols-12 lg:grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <HostPanel metrics={metrics} posture={sceneTone(posture?.tone)} criticals={openCritical} className="h-[26rem] lg:col-span-7 lg:h-auto" />
        <ShieldPanel posture={posture} className="h-[26rem] lg:col-span-5 lg:h-auto" />
        <PrioritiesPanel posture={posture} now={now} className="h-80 lg:col-span-4 lg:h-auto" />
        <DialPanel
          events={ov?.events_series ?? EMPTY_SERIES}
          alerts={ov?.alerts_series ?? EMPTY_SERIES}
          now={now}
          events24h={ov?.events_24h ?? 0}
          eventsTotal={ov?.events_total ?? 0}
          byChannel={ov?.by_channel ?? {}}
          className="h-80 lg:col-span-4 lg:h-auto"
        />
        <LiveFeed cases={cases} feed={feed} now={now} className="h-80 lg:col-span-4 lg:h-auto" />
      </div>
    </>
  );
}
