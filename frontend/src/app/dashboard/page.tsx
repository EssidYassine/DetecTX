"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchMetrics, fetchOverview, searchAlerts, type Alert, type Metrics, type Overview } from "@/lib/api";
import { ReportButton } from "@/components/report-button";
import { AlertDrawer } from "@/components/alert-drawer";
import { HostPanel } from "@/components/overview/host-panel";
import { ReactorPanel } from "@/components/overview/reactor-panel";
import { DialPanel } from "@/components/overview/dial-panel";
import { SkylinePanel } from "@/components/overview/skyline-panel";
import { DetectionsFeed } from "@/components/overview/detections-feed";
import { postureScore, postureTone } from "@/lib/posture";
import { withWorstSeverity } from "@/lib/mitre";

const EMPTY_SERIES: number[] = Array(24).fill(0);

/**
 * Centre de supervision : tout tient dans un écran (pas de défilement sur desktop).
 * Chaque widget est une scène 3D générée par Blender (assets/3d/) et animée par les
 * données réelles ; les chiffres et titres restent en 2D (HUD) pour la lisibilité.
 */
export default function OverviewPage() {
  const [ov, setOv] = useState<Overview | null>(null);
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [alertsTotal, setAlertsTotal] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [selected, setSelected] = useState<Alert | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);

  const loadOverview = useCallback(async () => {
    const [o, a] = await Promise.all([fetchOverview().catch(() => null), searchAlerts({ limit: 200 }).catch(() => null)]);
    if (o) setOv(o);
    if (a) {
      setAlerts([...a.items].sort((x, y) => y.created_at.localeCompare(x.created_at)));
      setAlertsTotal(a.total);
    }
    setNow(Date.now());
  }, []);
  const loadMetrics = useCallback(async () => {
    setMetrics(await fetchMetrics().catch(() => null));
  }, []);

  useEffect(() => {
    void loadOverview();
    void loadMetrics();
    const a = setInterval(() => void loadOverview(), 15000);
    const b = setInterval(() => void loadMetrics(), 3000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [loadOverview, loadMetrics]);

  const score = ov ? postureScore(ov.by_severity) : 100;
  const bySeverity = ov?.by_severity ?? {};
  const techniques = useMemo(() => withWorstSeverity(ov?.mitre_details ?? [], alerts), [ov?.mitre_details, alerts]);

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Centre de supervision</h1>
          <p className="truncate text-sm text-muted">Posture, menaces et santé du poste · temps réel · survolez et cliquez les objets 3D</p>
        </div>
        <ReportButton />
      </div>

      {/* Desktop : la grille remplit exactement l'écran. 13.25rem = barre du haut (68px)
          + marges du layout + en-tête de page, mesurés dans le navigateur. En dessous de
          ~690px de haut, la hauteur minimale reprend la main (défilement plutôt qu'écrasement). */}
      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[480px] lg:grid-cols-12 lg:grid-rows-[1.2fr_1fr]">
        <HostPanel
          metrics={metrics}
          posture={postureTone(score)}
          criticals={bySeverity.critical ?? 0}
          className="h-[26rem] lg:col-span-8 lg:h-auto"
        />
        <ReactorPanel
          alerts={alerts}
          total={alertsTotal}
          bySeverity={bySeverity}
          score={score}
          highlightId={highlightId}
          onSelect={setSelected}
          className="h-[26rem] lg:col-span-4 lg:h-auto"
        />
        <DialPanel
          events={ov?.events_series ?? EMPTY_SERIES}
          alerts={ov?.alerts_series ?? EMPTY_SERIES}
          now={now}
          events24h={ov?.events_24h ?? 0}
          eventsTotal={ov?.events_total ?? 0}
          byChannel={ov?.by_channel ?? {}}
          className="h-80 lg:col-span-3 lg:h-auto"
        />
        <SkylinePanel techniques={techniques} className="h-80 lg:col-span-5 lg:h-auto" />
        <DetectionsFeed
          alerts={alerts}
          now={now}
          highlightId={highlightId}
          onHighlight={setHighlightId}
          onSelect={setSelected}
          className="h-80 lg:col-span-4 lg:h-auto"
        />
      </div>

      <AlertDrawer alert={selected} onClose={() => setSelected(null)} />
    </>
  );
}
