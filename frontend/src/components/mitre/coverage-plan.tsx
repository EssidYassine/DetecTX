"use client";

import { useState } from "react";
import type { MitreCoverage } from "@/lib/api";

interface CoveragePlanProps {
  coverage: MitreCoverage;
  extra: ReadonlySet<string>;
  onToggleSource: (id: string) => void;
  onSelect: (id: string) => void;
  className?: string;
}

/** Plan de couverture : ce qui rapporterait le plus de techniques couvertes, et comment le faire. */
export function CoveragePlan({ coverage, extra, onToggleSource, onSelect, className = "" }: CoveragePlanProps) {
  const max = Math.max(1, ...coverage.plan.map((p) => p.techniques));
  const byId = new Map(coverage.techniques.map((t) => [t.id, t]));

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Plan de couverture</span>
        <span className="text-[11px] text-muted">du plus rentable au moins rentable</span>
      </div>
      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <ol className="space-y-3">
          {coverage.plan.length === 0 && <li className="text-sm text-muted">Toutes les sources gérées sont collectées : la couverture réelle égale la couverture théorique.</li>}
          {coverage.plan.map((p, i) => (
            <li key={p.source} className="rounded-xl border border-line bg-surface-2/40 p-3">
              <div className="flex items-start gap-3">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 font-mono text-xs text-accent">{i + 1}</span>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">Activer : {p.label}</p>
                  <p className="text-xs text-muted">
                    <span className="font-mono text-accent">+{p.techniques}</span> technique(s) couvertes · <span className="font-mono">+{p.rules.toLocaleString("fr-FR")}</span> règle(s) actives
                  </p>
                  <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-line">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(p.techniques / max) * 100}%` }} />
                  </div>
                  {p.how && <CopyCommand text={p.how} />}
                </div>
                <button
                  onClick={() => onToggleSource(p.source)}
                  aria-pressed={extra.has(p.source)}
                  className={`shrink-0 rounded-lg border px-2.5 py-1 text-[11px] transition ${extra.has(p.source) ? "border-accent/60 bg-accent/15 text-accent" : "border-line text-muted hover:text-foreground"}`}
                >
                  {extra.has(p.source) ? "Simulé ✓" : "Simuler"}
                </button>
              </div>
            </li>
          ))}
        </ol>

        <div>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted">Observées sans règle active</p>
          {coverage.observed_uncovered.length === 0 ? (
            <p className="text-xs text-muted">Chaque technique vue dans vos alertes a au moins une règle active.</p>
          ) : (
            <ul className="space-y-1">
              {coverage.observed_uncovered.map((id) => (
                <li key={id}>
                  <button onClick={() => onSelect(id)} className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-surface-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-critical" />
                    <span className="font-mono text-accent">{id}</span>
                    <span className="truncate">{byId.get(id)?.name ?? "hors référentiel"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-[11px] leading-relaxed text-muted">
            {coverage.totals.rules_inert.toLocaleString("fr-FR")} règle(s) portent sur une télémétrie que DeTecTX ne collecte pas (pilotes, WMI brut…) : elles ne sont comptées nulle part.
          </p>
        </div>
      </div>
    </div>
  );
}

function CopyCommand({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const [label, command] = text.includes(" : ") ? [text.slice(0, text.indexOf(" : ")), text.slice(text.indexOf(" : ") + 3)] : ["", text];
  return (
    <div className="mt-2">
      {label && <p className="mb-1 text-[11px] text-muted">{label}</p>}
      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{command}</code>
        <button
          onClick={() =>
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            })
          }
          className="shrink-0 text-[11px] text-accent hover:underline"
        >
          {copied ? "copié" : "copier"}
        </button>
      </div>
    </div>
  );
}
