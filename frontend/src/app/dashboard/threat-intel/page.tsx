"use client";

import { useState } from "react";
import { threatIntelLookup, type IntelResult } from "@/lib/api";
import { EmptyState } from "@/components/ui";

const VERDICT_TONE: Record<string, string> = {
  malicious: "critical",
  suspicious: "warn",
  known: "warn",
  clean: "ok",
  unknown: "muted",
  error: "muted",
};

function Badge({ verdict }: { verdict: string }) {
  const tone = VERDICT_TONE[verdict] ?? "muted";
  return (
    <span
      className="rounded px-2 py-0.5 text-xs font-medium capitalize"
      style={{
        color: `var(--${tone})`,
        backgroundColor: `color-mix(in srgb, var(--${tone}) 15%, transparent)`,
      }}
    >
      {verdict}
    </span>
  );
}

export default function ThreatIntelPage() {
  const [indicator, setIndicator] = useState("");
  const [result, setResult] = useState<IntelResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function lookup(e: React.FormEvent) {
    e.preventDefault();
    if (!indicator.trim()) return;
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      setResult(await threatIntelLookup(indicator.trim()));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Threat Intelligence</h1>
        <p className="text-sm text-muted">
          Réputation d’une IP, d’un hash ou d’un domaine via VirusTotal, AbuseIPDB et MISP.
        </p>
      </div>

      <form onSubmit={lookup} className="flex flex-wrap gap-2">
        <input
          value={indicator}
          onChange={(e) => setIndicator(e.target.value)}
          placeholder="IP, hash (MD5/SHA1/SHA256) ou domaine…"
          className="min-w-72 flex-1 rounded-lg border border-line bg-surface-2 px-4 py-2.5 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          disabled={loading}
          className="rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50"
        >
          {loading ? "Analyse…" : "Analyser"}
        </button>
      </form>

      {error && (
        <p className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
          {error}
        </p>
      )}

      {result && (
        <section className="space-y-4">
          <div className="flex items-center gap-3 rounded-xl border border-line bg-surface p-4">
            <div>
              <p className="font-mono text-sm">{result.indicator}</p>
              <p className="text-xs text-muted">Type : {result.type}{result.cached ? " · (cache)" : ""}</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <span className="text-sm text-muted">Verdict global</span>
              <Badge verdict={result.verdict} />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {result.providers.map((p) => (
              <div key={p.provider} className="rounded-xl border border-line bg-surface p-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="font-medium">{p.provider}</span>
                  <Badge verdict={p.verdict} />
                </div>
                <p className="text-sm text-muted">{p.detail}</p>
                {p.link && (
                  <a href={p.link} target="_blank" rel="noreferrer" className="mt-2 inline-block text-xs text-accent hover:underline">
                    Voir le rapport →
                  </a>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {!result && !loading && !error && (
        <EmptyState>Saisissez un indicateur (IP, hash, domaine) pour l’analyser.</EmptyState>
      )}
    </>
  );
}
