"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchAlertStats, fetchAlertTimeline, runDetection, type Alert, type AlertStats, type TimelineDay } from "@/lib/api";
import { AlertDrawer } from "@/components/alert-drawer";
import { ReportButton } from "@/components/report-button";
import { TimelinePanel, dayLabel } from "@/components/alerts/timeline-panel";
import { TriagePanel, type AlertQuery, type Severity } from "@/components/alerts/triage-panel";
import type { TimelineSelection } from "@/components/three/alert-timeline";

const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"];

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <AlertsView />
    </Suspense>
  );
}

/** Jour local (AAAA-MM-JJ) -> bornes ISO [début, lendemain) pour filtrer la liste. */
function dayWindow(iso: string) {
  const start = new Date(`${iso}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { since: start.toISOString(), until: end.toISOString(), label: dayLabel(iso) };
}

function AlertsView() {
  const sp = useSearchParams();
  const urlSeverity = sp.get("severity");
  const urlMitre = sp.get("mitre");
  const fromLink = Boolean(urlSeverity || urlMitre);

  // File de travail par défaut : les nouvelles ; « Toutes » si on arrive d'un lien filtré.
  const [query, setQuery] = useState<AlertQuery>(() => ({
    status: fromLink ? "all" : "new",
    severity: SEVERITIES.includes(urlSeverity as Severity) ? (urlSeverity as Severity) : "all",
    mitre: urlMitre,
    day: null,
    q: "",
    page: 0,
  }));
  const [selection, setSelection] = useState<TimelineSelection | null>(null);
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [days, setDays] = useState<TimelineDay[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [refreshKey, setRefreshKey] = useState(0);
  const [opened, setOpened] = useState<Alert | null>(null);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // Compteurs + chronologie (au chargement, puis après chaque triage / détection).
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAlertStats().catch(() => null), fetchAlertTimeline(30).catch(() => null)]).then(([s, d]) => {
      if (cancelled) return;
      if (s) setStats(s);
      if (d) setDays(d);
      setNow(Date.now());
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Tout changement de filtre ramène à la première page.
  const onQuery = useCallback((patch: Partial<AlertQuery>) => {
    setQuery((q) => ({ ...q, page: 0, ...patch }));
  }, []);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  function onTimelineSelect(sel: TimelineSelection | null) {
    setSelection(sel);
    if (!sel || !days[sel.day]) {
      onQuery({ day: null });
      return;
    }
    onQuery({ day: dayWindow(days[sel.day].date), ...(sel.severity ? { severity: sel.severity } : {}) });
  }

  async function handleRun() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await runDetection();
      setNotice(`${res.rules_run} règles exécutées, ${res.alerts_created} nouvelle(s) alerte(s).`);
      refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Détection impossible");
    } finally {
      setRunning(false);
    }
  }

  const closeDrawer = useCallback(() => setOpened(null), []);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold">Alertes de sécurité</h1>
          <p className="truncate text-sm text-muted">
            {notice ?? "Triez la file : prenez en charge, clôturez avec une conclusion, gardez la trace de qui a décidé."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <ReportButton />
          <button
            onClick={handleRun}
            disabled={running}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50"
          >
            {running ? "Analyse…" : "Lancer la détection"}
          </button>
        </div>
      </div>

      {/* Desktop : tout tient dans l'écran (même calcul que l'Overview) ; seul le tableau défile. */}
      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[480px] lg:grid-rows-[minmax(0,0.9fr)_minmax(0,2fr)]">
        <TimelinePanel days={days} selection={selection} onSelect={onTimelineSelect} className="h-64 lg:h-auto" />
        <TriagePanel
          query={query}
          onQuery={(patch) => {
            if ("day" in patch && patch.day === null) setSelection(null);
            onQuery(patch);
          }}
          counts={{ total: stats?.total ?? 0, byStatus: stats?.by_status ?? {} }}
          refreshKey={refreshKey}
          onOpen={setOpened}
          drawerOpen={opened !== null}
          onTriaged={refresh}
          now={now}
          className="h-[36rem] lg:h-auto"
        />
      </div>

      <AlertDrawer
        alert={opened}
        onClose={closeDrawer}
        onTriaged={(updated) => {
          setOpened(updated);
          refresh();
        }}
      />
    </>
  );
}
