"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchIntelIndicator, threatIntelLookup, type IntelIndicatorDetail, type IntelResult } from "@/lib/api";
import { fmtDate, SIGHTING_LABEL, TYPE_LABEL, VERDICT_LABEL, VERDICT_TONE } from "@/lib/intel";

const PROVIDER_TONE: Record<string, string> = { malicious: "critical", suspicious: "warn", known: "warn", clean: "accent", unknown: "muted", error: "muted" };

interface IndicatorDetailProps {
  value: string | null;
  canLookup: boolean; // analyste/admin et au moins une clé configurée
  anyProvider: boolean;
  className?: string;
}

/** Fiche d'un indicateur du poste : où il a été vu, qui le connaît, analyse en ligne à la demande. */
export function IndicatorDetail({ value, canLookup, anyProvider, className = "" }: IndicatorDetailProps) {
  const [state, setState] = useState<{ value: string; data: IntelIndicatorDetail | null; error: string | null } | null>(null);
  const [online, setOnline] = useState<{ value: string; busy: boolean; result: IntelResult | null; error: string | null } | null>(null);

  useEffect(() => {
    if (!value) return;
    let cancelled = false;
    fetchIntelIndicator(value)
      .then((data) => !cancelled && setState({ value, data, error: null }))
      .catch((e) => !cancelled && setState({ value, data: null, error: e instanceof Error ? e.message : "Fiche indisponible" }));
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!value) {
    return (
      <div className={`panel flex min-h-0 flex-col items-center justify-center p-6 text-center ${className}`}>
        <p className="text-sm font-medium">Choisissez un indicateur</p>
        <p className="mt-1 text-xs text-muted">dans la liste ou dans le tamis, pour voir où il a été vu et ce qu&apos;en disent les sources.</p>
      </div>
    );
  }
  const d = state?.value === value ? state.data : null;
  const result = online?.value === value && online.result ? online.result : d?.lookup ?? null;

  async function analyse() {
    if (!value) return;
    setOnline({ value, busy: true, result: null, error: null });
    try {
      setOnline({ value, busy: false, result: await threatIntelLookup(value), error: null });
    } catch (e) {
      setOnline({ value, busy: false, result: null, error: e instanceof Error ? e.message : "Analyse impossible" });
    }
  }

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="border-b border-line px-4 py-3">
        {d ? (
          <>
            <p className="text-[11px]" style={{ color: `var(--${VERDICT_TONE[d.verdict]})` }}>
              {TYPE_LABEL[d.type]} · {VERDICT_LABEL[d.verdict]}
            </p>
            <p className="mt-1 break-all font-mono text-sm font-semibold">{d.value}</p>
          </>
        ) : (
          <p className="text-xs text-muted">{state?.error ?? "Lecture de la fiche…"}</p>
        )}
      </div>

      {d && (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3 text-xs">
          <section>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Vu sur ce poste ({d.sightings})</p>
            <ul className="space-y-1.5">
              {d.all_sightings.map((s, i) => (
                <li key={i} className="rounded-lg bg-surface-2/60 px-2.5 py-1.5">
                  <p className="font-medium">{SIGHTING_LABEL[s.kind]}</p>
                  <p className="break-all text-[11px] text-muted">{s.label}</p>
                  <p className="text-[10px] text-muted">
                    {fmtDate(s.at)}
                    {s.kind === "connexion" || s.kind === "programme" ? (
                      <Link href="/dashboard/machines?vue=processus" className="ml-2 text-accent hover:underline">
                        voir le processus →
                      </Link>
                    ) : s.kind === "journal" && s.ref ? (
                      <Link href={`/dashboard/events?event=${encodeURIComponent(s.ref)}`} className="ml-2 text-accent hover:underline">
                        ouvrir l&apos;événement →
                      </Link>
                    ) : null}
                  </p>
                </li>
              ))}
            </ul>
          </section>

          <section>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Listes publiques</p>
            {d.feed_details.length === 0 ? (
              <p className="text-muted">Absent de toutes les listes chargées.</p>
            ) : (
              <ul className="space-y-1">
                {d.feed_details.map((f) => (
                  <li key={f.id} className="rounded-lg border border-critical/40 bg-critical/10 px-2.5 py-1.5">
                    <p className="font-medium text-critical">{f.name}</p>
                    <p className="text-[11px] text-muted">{f.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Analyse en ligne</p>
              {canLookup && (
                <button onClick={analyse} disabled={online?.value === value && online.busy} className="rounded-lg border border-line px-2.5 py-1 text-[11px] transition hover:border-accent/60 hover:text-accent disabled:opacity-50">
                  {online?.value === value && online.busy ? "Analyse…" : result ? "Relancer" : "Analyser"}
                </button>
              )}
            </div>
            {!anyProvider && <p className="text-[11px] text-muted">Aucune clé configurée (voir l&apos;onglet Sources) : rien n&apos;est envoyé.</p>}
            {online?.value === value && online.error && <p className="text-[11px] text-critical">{online.error}</p>}
            {result && (
              <ul className="space-y-1">
                {result.providers.map((p) => (
                  <li key={p.provider} className="flex items-start gap-2 rounded-lg bg-surface-2/60 px-2.5 py-1.5">
                    <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `var(--${PROVIDER_TONE[p.verdict] ?? "muted"})` }} />
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{p.provider}</span>
                      <span className="block text-[11px] text-muted">{p.detail}</span>
                    </span>
                    {p.link && (
                      <a href={p.link} target="_blank" rel="noreferrer noopener" className="shrink-0 text-[11px] text-accent hover:underline">
                        ↗
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {result?.cached && <p className="mt-1 text-[10px] text-muted">Résultat en cache (moins de 24 h).</p>}
          </section>
        </div>
      )}
    </div>
  );
}
