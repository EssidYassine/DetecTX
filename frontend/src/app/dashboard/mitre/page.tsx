"use client";

import { Suspense, useCallback, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { fetchMitreCoverage, type MitreCoverage } from "@/lib/api";
import { simulate } from "@/lib/attack";
import { usePolling } from "@/lib/use-polling";
import { HivePanel } from "@/components/mitre/hive-panel";
import { TechniqueDetail } from "@/components/mitre/technique-detail";
import { CoveragePlan } from "@/components/mitre/coverage-plan";

const REFRESH_MS = 60_000;
const TECHNIQUE = /^T\d{4}(\.\d{3})?$/;

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function MitrePage() {
  return (
    <Suspense fallback={null}>
      <MitreView />
    </Suspense>
  );
}

/**
 * Couverture MITRE ATT&CK RÉELLE : une règle ne protège que si sa source de données est collectée.
 * La ruche montre l'écart théorie / réalité ; le simulateur chiffre ce que rapporterait chaque source.
 */
function MitreView() {
  const sp = useSearchParams();
  const urlTechnique = sp.get("mitre");
  const [coverage, setCoverage] = useState<MitreCoverage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState<ReadonlySet<string>>(new Set());
  const [chosen, setChosen] = useState<string | null>(() => (urlTechnique && TECHNIQUE.test(urlTechnique) ? urlTechnique.toUpperCase() : null));

  const load = useCallback(async () => {
    try {
      setCoverage(await fetchMitreCoverage());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couverture indisponible");
    }
  }, []);
  usePolling(load, REFRESH_MS);

  const toggleSource = useCallback((id: string) => {
    setExtra((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const sim = useMemo(() => (coverage ? simulate(coverage, extra) : null), [coverage, extra]);
  // Fiche affichée : celle choisie, sinon la plus parlante (observée sans règle active, puis observée).
  const selected = chosen ?? coverage?.observed_uncovered[0] ?? coverage?.techniques.find((t) => t.alerts > 0)?.id ?? null;
  const t = coverage?.totals;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-nowrap">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">Couverture MITRE ATT&amp;CK</h1>
          <p className="truncate text-sm text-muted">
            {error ?? "Ce que DeTecTX détecte réellement sur ce poste — et ce qu'il détecterait si l'on collectait davantage."}
          </p>
        </div>
        {t && sim && (
          <div className="hidden shrink-0 gap-2 xl:flex">
            <Kpi label="Techniques couvertes" value={`${sim.techniques}`} sub={`/ ${t.techniques_theoretical} en théorie`} tone={sim.techniques / Math.max(1, t.techniques_theoretical) >= 0.6 ? "accent" : "warn"} />
            <Kpi label="Règles actives" value={sim.rules.toLocaleString("fr-FR")} sub={`/ ${t.rules_theoretical.toLocaleString("fr-FR")}`} tone={sim.rules / Math.max(1, t.rules_theoretical) >= 0.5 ? "accent" : "warn"} />
            <Kpi label="Observées" value={`${t.techniques_observed}`} sub={coverage!.observed_uncovered.length ? `dont ${coverage!.observed_uncovered.length} sans règle` : "toutes couvertes"} tone={coverage!.observed_uncovered.length ? "critical" : "accent"} />
            {coverage!.plan[0] && <Kpi label="Angle mort n° 1" value={coverage!.plan[0].source === "Security" ? "Sécurité" : coverage!.plan[0].source} sub={`+${coverage!.plan[0].techniques} techniques`} tone="warn" />}
          </div>
        )}
      </div>

      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[500px] lg:grid-cols-12 lg:grid-rows-[minmax(0,1.45fr)_minmax(0,1fr)]">
        {coverage && sim ? (
          <>
            <HivePanel coverage={coverage} extra={extra} onToggleSource={toggleSource} sim={sim} selected={selected} onSelect={setChosen} className="h-[28rem] lg:col-span-8 lg:h-auto" />
            <TechniqueDetail key={selected ?? "none"} id={selected} coverage={coverage} sources={sim.sources} className="h-[32rem] lg:col-span-4 lg:row-span-2 lg:h-auto" />
            <CoveragePlan coverage={coverage} extra={extra} onToggleSource={toggleSource} onSelect={setChosen} className="h-[24rem] lg:col-span-8 lg:h-auto" />
          </>
        ) : (
          <div className="panel flex items-center justify-center p-8 text-sm text-muted lg:col-span-12 lg:row-span-2">
            {error ?? "Analyse de la couverture (index des règles Sigma)…"}
          </div>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: string; sub: string; tone: string }) {
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
