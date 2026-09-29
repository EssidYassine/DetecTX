"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchIntelOverview, fetchMe, fetchVulns, refreshFeeds, refreshVulns, toggleFeed, type IntelOverview, type User, type VulnReport } from "@/lib/api";
import { fmtDate } from "@/lib/intel";
import { usePolling } from "@/lib/use-polling";
import { SievePanel } from "@/components/intel/sieve-panel";
import { IndicatorTable } from "@/components/intel/indicator-table";
import { IndicatorDetail } from "@/components/intel/indicator-detail";
import { VulnsView } from "@/components/intel/vulns-view";

type Tab = "ioc" | "vulns";
const OVERVIEW_MS = 60_000;

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function ThreatIntelPage() {
  return (
    <Suspense fallback={null}>
      <IntelView />
    </Suspense>
  );
}

/**
 * Threat Intel DU POSTE : ses indicateurs (IP contactées, programmes, domaines vus) passés au
 * crible de listes publiques comparées en local, et ses vulnérabilités (Windows Update, KEV).
 * Aucun IOC arbitraire : uniquement ce qui concerne cette machine.
 */
function IntelView() {
  const sp = useSearchParams();
  const [tab, setTab] = useState<Tab>(sp.get("vue") === "vulns" ? "vulns" : "ioc");
  const [ov, setOv] = useState<IntelOverview | null>(null);
  const [vr, setVr] = useState<VulnReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    try {
      setOv(await fetchIntelOverview());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Renseignement indisponible");
    }
  }, []);
  const loadVulns = useCallback(async () => {
    const r = await fetchVulns().catch(() => null);
    if (r) setVr(r);
  }, []);
  usePolling(loadOverview, OVERVIEW_MS);
  usePolling(loadVulns, vr?.running ? 15_000 : OVERVIEW_MS); // plus fréquent pendant une analyse

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((u) => !cancelled && setUser(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const isAdmin = user?.role === "admin";
  const canAnalyse = user?.role === "admin" || user?.role === "analyst";
  const anyProvider = (ov?.totals.providers_configured ?? 0) > 0;
  // Fiche affichée : celle choisie, sinon le premier indicateur reconnu, sinon le premier.
  const current = selected ?? ov?.indicators.find((i) => i.verdict !== "unknown")?.value ?? ov?.indicators[0]?.value ?? null;

  async function act(fn: () => Promise<unknown>, done: string) {
    setBusy(true);
    try {
      await fn();
      setNotice(done);
      await loadOverview();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action impossible");
    } finally {
      setBusy(false);
    }
  }

  const t = ov?.totals;
  const updates = vr?.windows_update.updates.length ?? 0;
  const vulnerable = vr?.findings.filter((f) => f.status === "vulnerable").length ?? 0;
  const lastFeed = ov?.feeds.map((f) => f.updated).filter(Boolean).sort().at(-1) ?? null;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-nowrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold">Renseignement sur ce poste</h1>
            <div className="flex rounded-lg border border-line p-0.5 text-xs" role="tablist" aria-label="Vue">
              {(
                [
                  ["ioc", "Indicateurs du poste"],
                  ["vulns", "Vulnérabilités"],
                ] as const
              ).map(([key, label]) => (
                <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`rounded-md px-2.5 py-1 transition ${tab === key ? "bg-accent text-accent-fg" : "text-muted hover:text-foreground"}`}>
                  {label}
                  {key === "vulns" && (updates || vulnerable) ? <span className="ml-1.5 rounded-full bg-warn/20 px-1.5 font-mono text-[10px] text-warn">{updates + vulnerable}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <p className="truncate text-sm text-muted">
            {error ?? notice ?? (tab === "ioc" ? "Ce que votre machine contacte, exécute et télécharge, comparé en local aux listes publiques de menaces." : "Mises à jour manquantes et logiciels touchés par des failles activement exploitées.")}
          </p>
        </div>
        {tab === "ioc" && t && (
          <div className="hidden shrink-0 gap-2 xl:flex">
            <Kpi label="Indicateurs du poste" value={t.indicators} sub={`${t.ips} IP · ${t.hashes} prog. · ${t.domains} dom.`} tone="foreground" />
            <Kpi label="Reconnus" value={t.matches} sub={t.matches ? "à examiner" : "aucun"} tone={t.matches ? "critical" : "accent"} />
            <Kpi label="Sources actives" value={`${t.feeds_active + t.providers_configured}/9`} sub={`${t.feeds_active} listes · ${t.providers_configured} clés`} tone={t.providers_configured ? "accent" : "warn"} />
            <Kpi label="Listes à jour" value={lastFeed ? fmtDate(lastFeed) : "—"} sub="toutes les 12 h" tone="foreground" />
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[480px] lg:grid-cols-12 lg:grid-rows-2">
        {tab === "ioc" ? (
          ov ? (
            <>
              <SievePanel
                overview={ov}
                selected={current}
                onSelect={setSelected}
                isAdmin={isAdmin}
                busy={busy}
                onRefreshFeeds={() => void act(refreshFeeds, "Listes publiques mises à jour.")}
                onToggleFeed={(id, enabled) => void act(() => toggleFeed(id, enabled), enabled ? "Liste activée." : "Liste désactivée.")}
                className="h-[28rem] lg:col-span-4 lg:row-span-2 lg:h-auto"
              />
              <IndicatorTable indicators={ov.indicators} selected={current} onSelect={setSelected} className="h-[28rem] lg:col-span-5 lg:row-span-2 lg:h-auto" />
              <IndicatorDetail key={current ?? "none"} value={current} canLookup={canAnalyse && anyProvider} anyProvider={anyProvider} className="h-[28rem] lg:col-span-3 lg:row-span-2 lg:h-auto" />
            </>
          ) : (
            <div className="panel flex items-center justify-center p-8 text-sm text-muted lg:col-span-12 lg:row-span-2">{error ?? "Inventaire des indicateurs du poste…"}</div>
          )
        ) : (
          <VulnsView
            report={vr}
            isAdmin={isAdmin}
            notice={notice}
            onRescan={() =>
              void refreshVulns()
                .then((r) => {
                  setNotice(r.detail);
                  return loadVulns();
                })
                .catch((e) => setNotice(e instanceof Error ? e.message : "Analyse impossible"))
            }
          />
        )}
      </div>
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: number | string; sub: string; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="flex items-baseline gap-1.5 font-mono text-sm font-semibold tabular-nums leading-tight" style={{ color: `var(--${tone})` }}>
        {value}
        <span className="font-sans text-[10px] font-normal text-muted">{sub}</span>
      </p>
    </div>
  );
}
