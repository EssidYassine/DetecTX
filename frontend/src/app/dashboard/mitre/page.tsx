"use client";

import { useEffect, useState } from "react";
import { fetchAlertStats, fetchDetectionRules, type RuleInfo } from "@/lib/api";
import { EmptyState, SeverityBadge } from "@/components/ui";

export default function MitrePage() {
  const [rules, setRules] = useState<RuleInfo[]>([]);
  const [detected, setDetected] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([fetchDetectionRules().catch(() => []), fetchAlertStats().catch(() => null)]).then(
      ([r, s]) => {
        setRules(r);
        if (s) setDetected(s.by_mitre);
        setLoading(false);
      },
    );
  }, []);

  return (
    <>
      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm text-muted">Techniques couvertes</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-accent">
            {loading ? "…" : new Set(rules.map((r) => r.mitre).filter(Boolean)).size}
          </p>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm text-muted">Techniques déclenchées</p>
          <p className="mt-2 text-3xl font-semibold tabular-nums text-warn">
            {loading ? "…" : Object.keys(detected).length}
          </p>
        </div>
      </section>

      <section className="rounded-xl border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 font-medium">
          Couverture MITRE ATT&amp;CK — règles de détection
        </h2>
        {rules.length === 0 ? (
          <EmptyState>{loading ? "Chargement…" : "Aucune règle chargée."}</EmptyState>
        ) : (
          <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
            {rules.map((r) => {
              const count = r.mitre ? (detected[r.mitre] ?? 0) : 0;
              return (
                <div
                  key={r.id}
                  className="rounded-lg border border-line bg-surface-2 p-4"
                  style={count > 0 ? { borderColor: "var(--warn)" } : undefined}
                >
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-sm text-accent">{r.mitre ?? "—"}</span>
                    <SeverityBadge severity={r.severity} />
                  </div>
                  <p className="mt-2 text-sm">{r.title}</p>
                  <p className="mt-2 text-xs text-muted">
                    {count > 0 ? `${count} alerte(s) déclenchée(s)` : "aucune détection"}
                  </p>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}
