"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  fetchCollectionHealth,
  fetchEventHistogram,
  fetchFeed,
  fetchHunts,
  fetchMe,
  type CollectionHealth,
  type EventHistogram,
  type FeedItem,
  type Hunt,
} from "@/lib/api";
import { binWindow, fmtHourRange, LIST_WINDOWS, PERIODS, SOURCES, type PeriodKey } from "@/lib/events-ui";
import { usePolling } from "@/lib/use-polling";
import { ReportButton } from "@/components/report-button";
import type { ReliefSlice } from "@/components/three/event-relief";
import { ReliefPanel } from "@/components/events/relief-panel";
import { HEALTH_TONE } from "@/components/events/health-panel";
import { SidePanel } from "@/components/events/side-panel";
import { ThemeStrip } from "@/components/events/theme-strip";
import { HuntPanel, type EventQuery } from "@/components/events/hunt-panel";
import { EventReader } from "@/components/events/event-reader";

const HEALTH_MS = 15_000; // collecteur intégré : relève toutes les 10 s, agent : 15 s
const FEED_MS = 15_000;
const RELIEF_MS = 60_000;
const HUNTS_MS = 60_000;

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function EventsPage() {
  return (
    <Suspense fallback={null}>
      <EventsView />
    </Suspense>
  );
}

/** Fenêtre « dernières N minutes » (lien depuis le cadran 24 h de l'Overview) -> tranche. */
function initialQuery(channel: string | null, minutes: number | null): EventQuery {
  const valid = minutes !== null && Number.isInteger(minutes) && minutes > 0 && minutes <= 7 * 24 * 60;
  const until = new Date();
  const since = valid ? new Date(until.getTime() - (minutes as number) * 60_000) : null;
  return {
    hunt: null,
    channel: channel && SOURCES.some((s) => s.channel === channel) ? channel : "",
    theme: null,
    eventId: null,
    q: "",
    window: "7d",
    slice: since ? { since: since.toISOString(), until: until.toISOString(), label: `Dernières ${minutes} min` } : null,
    page: 0,
  };
}

function EventsView() {
  const sp = useSearchParams();
  const [query, setQuery] = useState<EventQuery>(() => initialQuery(sp.get("channel"), sp.get("minutes") ? Number(sp.get("minutes")) : null));
  const [period, setPeriod] = useState<PeriodKey>("48h");
  const [histogram, setHistogram] = useState<EventHistogram | null>(null);
  const [health, setHealth] = useState<CollectionHealth | null>(null);
  const [hunts, setHunts] = useState<Hunt[] | null>(null);
  const [feed, setFeed] = useState<FeedItem[] | null>(null);
  const [email, setEmail] = useState<string | null>(null);
  const [relief, setRelief] = useState<ReliefSlice | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);

  const hours = PERIODS.find((p) => p.key === period)?.hours ?? 48;

  const loadHealth = useCallback(async () => {
    try {
      setHealth(await fetchCollectionHealth());
      setNow(Date.now());
    } catch {
      // Santé indisponible : on garde le dernier état connu.
    }
  }, []);
  const loadRelief = useCallback(async () => {
    try {
      setHistogram(await fetchEventHistogram(hours));
      setRefreshKey((k) => k + 1); // la liste suit le rythme du relief
    } catch {
      // Relief indisponible : la vue garde le dernier relevé.
    }
  }, [hours]);
  // Compteurs des chasses sur la même période que la liste (« Tout » = 90 jours, plafond de l'API).
  const huntMinutes = LIST_WINDOWS.find((w) => w.key === query.window)?.minutes ?? 60 * 24 * 90;
  const loadHunts = useCallback(async () => {
    try {
      setHunts(await fetchHunts(huntMinutes));
    } catch {
      // Chasses indisponibles : la liste reste utilisable sans elles.
    }
  }, [huntMinutes]);

  const loadFeed = useCallback(async () => {
    try {
      setFeed(await fetchFeed());
      setNow(Date.now());
    } catch {
      // Fil indisponible : on garde les dernières lignes.
    }
  }, []);

  usePolling(loadHealth, HEALTH_MS);
  usePolling(loadFeed, FEED_MS);
  usePolling(loadRelief, RELIEF_MS);
  usePolling(loadHunts, HUNTS_MS);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((me) => !cancelled && setEmail(me.email))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpened(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Tout changement de filtre ramène à la première page (sauf la pagination elle-même).
  const onQuery = useCallback((patch: Partial<EventQuery>) => {
    if ("slice" in patch && patch.slice === null) setRelief(null);
    if ("theme" in patch && patch.theme === null) setRelief((r) => (r ? { ...r, lane: null } : r));
    setQuery((q) => ({ ...q, ...("page" in patch ? {} : { page: 0 }), ...patch }));
  }, []);

  function onReliefSelect(slice: ReliefSlice | null) {
    setRelief(slice);
    if (!slice || !histogram) {
      onQuery({ slice: null });
      return;
    }
    const label = fmtHourRange(histogram.start, slice.bin);
    setQuery((q) => ({ ...q, page: 0, hunt: null, eventId: null, channel: "", theme: slice.lane, slice: { ...binWindow(histogram.start, slice.bin), label } }));
  }

  function onThemePick(theme: string | null) {
    setRelief((r) => (r ? { ...r, lane: theme } : r));
    setQuery((q) => ({ ...q, page: 0, hunt: null, eventId: null, channel: "", theme }));
  }

  const tone = health ? HEALTH_TONE[health.status] : "muted";

  return (
    <>
      {/* Une seule ligne sur desktop : le résumé se tronque plutôt que de pousser la grille (pas de scroll de page). */}
      <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-nowrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Journaux &amp; chasse</h1>
          <p className="truncate text-sm text-muted">
            {health ? (
              <span style={{ color: `var(--${tone})` }}>{health.summary}</span>
            ) : (
              "Ce que Windows a enregistré, lu en clair, et les questions à lui poser."
            )}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <ThemeStrip histogram={histogram} active={query.theme} onPick={onThemePick} className="hidden 2xl:flex" />
          <ReportButton />
        </div>
      </div>

      {/* Desktop : tout tient dans l'écran ; seules la liste et les fiches défilent. */}
      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[520px] lg:grid-cols-12 lg:grid-rows-[minmax(0,0.95fr)_minmax(0,1.25fr)]">
        <ReliefPanel histogram={histogram} period={period} onPeriod={setPeriod} selected={relief} onSelect={onReliefSelect} className="h-80 lg:col-span-8 lg:h-auto" />
        <SidePanel feed={feed} health={health} email={email} now={now} selected={opened} onOpen={setOpened} className="h-80 lg:col-span-4 lg:h-auto" />
        <HuntPanel
          query={query}
          onQuery={onQuery}
          hunts={hunts}
          health={health}
          selected={opened}
          onOpen={setOpened}
          refreshKey={refreshKey}
          className="h-[32rem] lg:col-span-8 lg:h-auto"
        />
        <EventReader eventId={opened} onClose={() => setOpened(null)} className="h-[28rem] lg:col-span-4 lg:h-auto" />
      </div>
    </>
  );
}
