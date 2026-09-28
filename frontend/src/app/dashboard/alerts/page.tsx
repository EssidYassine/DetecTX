"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  fetchAlertCases,
  fetchAlertStats,
  fetchAlertTimeline,
  runDetection,
  triageCase,
  type AlertStats,
  type CasePage,
  type TimelineDay,
  type TriageInput,
} from "@/lib/api";
import { fmtDuration, SEVERITIES, type Severity } from "@/lib/cases";
import { RESOLUTION_LABEL, STATUS_LABEL } from "@/lib/triage";
import { usePolling } from "@/lib/use-polling";
import { ReportButton } from "@/components/report-button";
import { RadarPanel, dayLabel } from "@/components/alerts/radar-panel";
import { CaseList, QueueFrame, type QueueQuery, type StatusFilter, type ViewMode } from "@/components/alerts/case-list";
import { AlertTable } from "@/components/alerts/alert-table";
import { CaseDetail } from "@/components/alerts/case-detail";

const REFRESH_MS = 30_000;

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <AlertsView />
    </Suspense>
  );
}

/** Jour local (AAAA-MM-JJ) -> bornes ISO [début, lendemain) pour filtrer la file. */
function dayWindow(iso: string) {
  const start = new Date(`${iso}T00:00:00`);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { since: start.toISOString(), until: end.toISOString(), label: dayLabel(iso), date: iso };
}

function AlertsView() {
  const sp = useSearchParams();
  const urlSeverity = sp.get("severity");
  const urlMitre = sp.get("mitre");
  const fromLink = Boolean(urlSeverity || urlMitre);

  // File de travail par défaut : ce qui reste à traiter ; « Toutes » si on arrive d'un lien filtré.
  const [query, setQuery] = useState<QueueQuery>(() => ({
    status: fromLink ? "all" : "open",
    severity: SEVERITIES.includes(urlSeverity as Severity) ? (urlSeverity as Severity) : "all",
    mitre: urlMitre && /^T\d{4}(\.\d{3})?$/.test(urlMitre) ? urlMitre : null,
    day: null,
    q: "",
  }));
  const [mode, setMode] = useState<ViewMode>("cases");
  const [selected, setSelected] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [stats, setStats] = useState<AlertStats | null>(null);
  const [days, setDays] = useState<TimelineDay[]>([]);
  const [notice, setNotice] = useState<{ text: string; tone: "accent" | "critical" } | null>(null);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  const onQuery = useCallback((patch: Partial<QueueQuery>) => setQuery((q) => ({ ...q, ...patch })), []);

  // Dossiers : l'atténuation « chargement » ne suit que les changements de filtre (pas le rafraîchissement).
  const queryKey = JSON.stringify(query);
  const [loaded, setLoaded] = useState<{ queryKey: string; page: CasePage | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    fetchAlertCases({
      status: query.status === "all" ? undefined : query.status,
      severity: query.severity,
      mitre: query.mitre ?? undefined,
      since: query.day?.since,
      until: query.day?.until,
      q: query.q || undefined,
    })
      .then((page) => {
        if (cancelled) return;
        setLoaded({ queryKey, page, error: null });
        setNow(Date.now());
      })
      .catch((e) => !cancelled && setLoaded((prev) => ({ queryKey, page: prev?.page ?? null, error: e instanceof Error ? e.message : "Chargement impossible" })));
    return () => {
      cancelled = true;
    };
  }, [queryKey, query, refreshKey]);
  const page = loaded?.page ?? null;
  const cases = page?.cases ?? null;
  const summary = page?.summary ?? null;

  // Compteurs par statut + barres des 30 jours (au chargement, puis à chaque rafraîchissement).
  useEffect(() => {
    let cancelled = false;
    Promise.all([fetchAlertStats().catch(() => null), fetchAlertTimeline(30).catch(() => null)]).then(([s, d]) => {
      if (cancelled) return;
      if (s) setStats(s);
      if (d) setDays(d);
    });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  usePolling(useCallback(async () => refresh(), [refresh]), REFRESH_MS);

  // Dossier affiché : celui choisi s'il est encore dans la file, sinon le premier (le plus urgent).
  const current = cases?.find((c) => c.rule_id === selected) ?? cases?.[0] ?? null;

  const onTriage = useCallback(
    async (ruleId: string, input: TriageInput) => {
      if (busy) return;
      setBusy(true);
      try {
        const res = await triageCase(ruleId, input);
        const what =
          input.status === "closed" && input.resolution
            ? `clôturée(s) · ${RESOLUTION_LABEL[input.resolution].toLowerCase()}`
            : input.status === "ack"
              ? "prise(s) en charge"
              : "rouverte(s)";
        setNotice({ text: res.updated ? `${res.updated} alerte(s) ${what}.` : "Rien à changer dans ce dossier.", tone: "accent" });
        refresh();
      } catch (e) {
        setNotice({ text: e instanceof Error ? e.message : "Triage impossible", tone: "critical" });
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
  );

  async function handleRun() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await runDetection();
      setNotice({ text: `${res.rules_run} règles exécutées, ${res.alerts_created} nouvelle(s) alerte(s).`, tone: "accent" });
      refresh();
    } catch (err) {
      setNotice({ text: err instanceof Error ? err.message : "Détection impossible", tone: "critical" });
    } finally {
      setRunning(false);
    }
  }

  const byStatus = stats?.by_status ?? {};
  const counts: Partial<Record<StatusFilter, number>> = {
    open: (byStatus.new ?? 0) + (byStatus.ack ?? 0),
    new: byStatus.new ?? 0,
    ack: byStatus.ack ?? 0,
    closed: byStatus.closed ?? 0,
    all: stats?.total ?? 0,
  };
  const tpRate = summary && summary.closed > 0 ? Math.round((summary.true_positive / summary.closed) * 100) : null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-nowrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Alertes de sécurité</h1>
          <p className="truncate text-sm" style={{ color: notice ? `var(--${notice.tone})` : undefined }}>
            {notice ? notice.text : <span className="text-muted">Chaque détection devient un dossier : on le lit, on décide, la décision est tracée.</span>}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {summary && (
            <div className="hidden gap-2 xl:flex">
              <Kpi label="À traiter" value={summary.open_alerts} hint={`${summary.open_cases} dossier(s)`} tone={summary.open_alerts ? "accent" : "muted"} />
              <Kpi label="Critiques ouvertes" value={summary.open_critical} tone={summary.open_critical ? "critical" : "muted"} />
              <Kpi label="Tactiques touchées" value={`${summary.tactics_hit.length}/14`} tone={summary.tactics_hit.length >= 4 ? "warn" : "muted"} />
              <Kpi
                label="Délai de triage"
                value={summary.mean_triage_minutes === null ? "—" : fmtDuration(summary.mean_triage_minutes)}
                hint={tpRate === null ? "aucune clôture" : `${tpRate} % vrais positifs`}
                tone="muted"
              />
            </div>
          )}
          <ReportButton />
          <button onClick={handleRun} disabled={running} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50">
            {running ? "Analyse…" : "Lancer la détection"}
          </button>
        </div>
      </div>

      {/* Desktop : tout tient dans l'écran ; seules la file et la fiche défilent. */}
      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[480px] lg:grid-cols-12 lg:grid-rows-[minmax(0,1fr)_minmax(0,1.1fr)]">
        <RadarPanel
          cases={cases ?? []}
          days={days}
          now={now}
          selected={current?.rule_id ?? null}
          onSelect={setSelected}
          day={query.day?.date ?? null}
          onDay={(d) => onQuery({ day: d ? dayWindow(d) : null })}
          className="h-80 lg:col-span-7 lg:h-auto"
        />
        <CaseDetail
          key={current?.rule_id ?? "none"}
          c={current}
          now={now}
          refreshKey={refreshKey}
          onTriage={onTriage}
          onTriaged={refresh}
          busy={busy}
          className="h-[36rem] lg:col-span-5 lg:row-span-2 lg:h-auto"
        />
        {mode === "cases" ? (
          <CaseList
            query={query}
            onQuery={onQuery}
            counts={counts}
            cases={cases}
            loading={loaded?.queryKey !== queryKey}
            error={loaded?.error ?? null}
            selected={current?.rule_id ?? null}
            onSelect={setSelected}
            onTriage={(id, input) => void onTriage(id, input)}
            now={now}
            mode={mode}
            onMode={setMode}
            className="h-[32rem] lg:col-span-7 lg:h-auto"
          />
        ) : (
          <QueueFrame query={query} onQuery={onQuery} counts={counts} mode={mode} onMode={setMode} className="h-[32rem] lg:col-span-7 lg:h-auto">
            <AlertTable query={query} refreshKey={refreshKey} onOpen={(a) => setSelected(a.rule_id)} onTriaged={refresh} now={now} />
          </QueueFrame>
        )}
      </div>
      <p className="sr-only" aria-live="polite">
        {current ? `Dossier affiché : ${current.rule_title}, ${STATUS_LABEL[current.by_status.new ? "new" : current.by_status.ack ? "ack" : "closed"]}` : ""}
      </p>
    </>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: number | string; hint?: string; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-1.5" title={hint}>
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="flex items-baseline gap-1.5 font-mono text-sm font-semibold tabular-nums leading-tight" style={{ color: `var(--${tone === "muted" ? "foreground" : tone})` }}>
        {value}
        {hint && <span className="font-sans text-[10px] font-normal text-muted">{hint}</span>}
      </p>
    </div>
  );
}
