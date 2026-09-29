"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchTechnique, type MitreCoverage, type TechniqueDetail as Detail } from "@/lib/api";
import { effectiveWith, tacticLabel } from "@/lib/attack";

const SEV_TONE: Record<string, string> = { critical: "critical", high: "warn", medium: "accent", low: "muted" };
const ORIGIN: Record<string, string> = { sigma: "SigmaHQ", interne: "DeTecTX", perso: "Ma règle" };
const MAX_RULES = 60;

interface TechniqueDetailProps {
  id: string | null;
  coverage: MitreCoverage;
  sources: ReadonlySet<string>; // sources collectées + simulées
  className?: string;
}

/** Fiche d'une technique : ce qu'elle est, ce qui la détecte VRAIMENT, et pourquoi le reste est aveugle. */
export function TechniqueDetail({ id, coverage, sources, className = "" }: TechniqueDetailProps) {
  const [state, setState] = useState<{ id: string; data: Detail | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    fetchTechnique(id)
      .then((data) => !cancelled && setState({ id, data, error: null }))
      .catch((e) => !cancelled && setState({ id, data: null, error: e instanceof Error ? e.message : "Fiche indisponible" }));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (!id) {
    return (
      <div className={`panel flex min-h-0 flex-col items-center justify-center p-8 text-center ${className}`}>
        <p className="text-sm font-medium">Choisissez une alvéole</p>
        <p className="mt-1 text-xs text-muted">ou cherchez une technique (T1055, « LSASS »…) pour voir ce qui la détecte réellement.</p>
      </div>
    );
  }
  const data = state?.id === id ? state.data : null;
  const loading = state?.id !== id;
  const t = coverage.techniques.find((x) => x.id === id);
  const active = t ? effectiveWith(t, sources) : 0;
  const sourceLabel = new Map(coverage.sources.map((s) => [s.id, s.label]));
  const pct = t && t.theoretical ? Math.round((active / t.theoretical) * 100) : 0;
  const tone = !t || t.theoretical === 0 ? "muted" : active === 0 ? "warn" : "accent";

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-center gap-2 text-[11px]">
          <span className="font-mono font-semibold text-accent">{id}</span>
          {t?.alerts ? (
            <Link href={`/dashboard/alerts?mitre=${encodeURIComponent(id)}`} className="rounded-full bg-critical/15 px-2 py-0.5 font-medium text-critical hover:underline">
              {t.alerts} alerte(s){t.alerts_open ? `, ${t.alerts_open} ouverte(s)` : ""} →
            </Link>
          ) : null}
          <a href={t?.url ?? `https://attack.mitre.org/techniques/${id.replace(".", "/")}`} target="_blank" rel="noreferrer noopener" className="ml-auto text-muted hover:text-accent">
            attack.mitre.org ↗
          </a>
        </div>
        <h2 className="mt-1 text-base font-semibold leading-snug">{t?.name ?? "Technique hors référentiel Windows"}</h2>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {(t?.tactics ?? []).filter((x) => x !== "unknown").map((x) => (
            <span key={x} className="rounded-full border border-line px-2 py-0.5 text-[10px] text-muted">
              {tacticLabel(x)}
            </span>
          ))}
        </div>
        {t?.desc && (
          <p className="mt-2 text-xs leading-relaxed text-muted">
            {t.desc} <span className="text-[10px] opacity-70">(description officielle MITRE)</span>
          </p>
        )}
      </div>

      {/* Couverture : active vs théorique, par source */}
      {t && (
        <div className="border-b border-line px-4 py-3">
          <div className="flex items-baseline justify-between text-xs">
            <span className="font-medium" style={{ color: `var(--${tone})` }}>
              {t.theoretical === 0 ? "Aucune règle ne couvre cette technique" : active === 0 ? "Angle mort : aucune règle active" : `${active} règle(s) active(s)`}
            </span>
            <span className="font-mono tabular-nums text-muted">
              {active}/{t.theoretical}
            </span>
          </div>
          <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full transition-all duration-700" style={{ width: `${pct}%`, backgroundColor: `var(--${tone})` }} />
          </div>
          <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
            {Object.entries(t.by_source)
              .sort((a, b) => b[1] - a[1])
              .map(([src, n]) => {
                const on = src === "any" || sources.has(src);
                return (
                  <li key={src} className="flex items-center gap-1.5" title={sourceLabel.get(src) ?? src}>
                    <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(--${on ? "accent" : "warn"})` }} />
                    <span className={on ? "" : "text-muted"}>{src === "any" ? "Toute source" : src}</span>
                    <span className="ml-auto font-mono tabular-nums text-muted">{n}</span>
                  </li>
                );
              })}
          </ul>
          {t.inert > 0 && <p className="mt-1.5 text-[10px] text-muted">+ {t.inert} règle(s) sur une télémétrie que DeTecTX ne collecte pas.</p>}
        </div>
      )}

      {/* Règles */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-2">
        {loading && <p className="text-xs text-muted">Chargement des règles…</p>}
        {state?.error && !loading && <p className="text-xs text-critical">{state.error}</p>}
        {data && data.rules.length === 0 && (
          <div className="py-4 text-center text-xs text-muted">
            <p>Aucune règle pour cette technique.</p>
            <Link href="/dashboard/events" className="mt-2 inline-block rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-accent hover:bg-accent/20">
              ◆ Créer une règle depuis les journaux
            </Link>
          </div>
        )}
        <ul className="space-y-1">
          {data?.rules.slice(0, MAX_RULES).map((r) => {
            const on = r.source === "any" || sources.has(r.source); // tient compte du simulateur
            return (
              <li key={`${r.origin}:${r.id}`} className={`rounded-lg px-2 py-1.5 text-xs ${on ? "bg-surface-2/60" : "opacity-60"}`}>
                <p className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `var(--${on ? "accent" : "muted"})` }} />
                  <span className="truncate" title={r.title}>
                    {r.title}
                  </span>
                  <span className="ml-auto shrink-0 text-[10px]" style={{ color: `var(--${SEV_TONE[r.severity] ?? "muted"})` }}>
                    {r.severity}
                  </span>
                </p>
                <p className="ml-3.5 text-[10px] text-muted">
                  {ORIGIN[r.origin] ?? r.origin} · {on ? "active" : r.source === "inert" ? "télémétrie non collectable" : `nécessite ${sourceLabel.get(r.source) ?? r.source}`}
                </p>
              </li>
            );
          })}
        </ul>
        {data && data.rules.length > MAX_RULES && <p className="py-2 text-center text-[11px] text-muted">… et {data.rules.length - MAX_RULES} autre(s).</p>}
      </div>
    </div>
  );
}
