"use client";

import { useEffect, useState } from "react";
import { explainAlert, type Alert, type Explanation } from "@/lib/api";
import { SeverityBadge } from "@/components/ui";

export function AlertDrawer({ alert, onClose }: { alert: Alert | null; onClose: () => void }) {
  const [expl, setExpl] = useState<Explanation | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!alert) return;
    setExpl(null);
    setError(null);
    setLoading(true);
    explainAlert(alert.id)
      .then(setExpl)
      .catch((e) => setError(e instanceof Error ? e.message : "Erreur"))
      .finally(() => setLoading(false));
  }, [alert]);

  return (
    <>
      <div
        onClick={onClose}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity ${
          alert ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <aside
        className={`fixed inset-y-0 right-0 z-50 w-full max-w-xl overflow-y-auto border-l border-line bg-surface transition-transform duration-300 ${
          alert ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {alert && (
          <div className="space-y-5 p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2">
                  <SeverityBadge severity={alert.severity} />
                  <span className="font-mono text-xs text-accent">{alert.mitre ?? "—"}</span>
                </div>
                <h2 className="mt-2 text-xl font-semibold">{alert.rule_title}</h2>
              </div>
              <button
                onClick={onClose}
                className="rounded-lg border border-line px-2 py-1 text-muted transition hover:text-foreground"
              >
                ✕
              </button>
            </div>

            {loading && <p className="text-sm text-muted">Analyse par l’IA…</p>}
            {error && (
              <p className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">
                {error}
              </p>
            )}

            {expl && (
              <>
                <div className="flex items-center gap-2 text-xs">
                  <span className="rounded-full border border-line px-2 py-0.5 text-muted">
                    {expl.source === "builtin" ? "Analyse intégrée" : `IA · ${expl.source}`}
                  </span>
                  <span className="text-muted">{expl.mitre_name} · {expl.tactic}</span>
                </div>

                {expl.ai_narrative && (
                  <Section title="Synthèse IA">
                    <p className="whitespace-pre-wrap text-sm leading-relaxed">{expl.ai_narrative}</p>
                  </Section>
                )}
                <Section title="Description"><p className="text-sm leading-relaxed">{expl.description}</p></Section>
                <Section title="Cause"><p className="text-sm leading-relaxed text-muted">{expl.cause}</p></Section>
                <Section title="Impact"><p className="text-sm leading-relaxed">{expl.impact}</p></Section>
                <Section title="Remédiation">
                  <ul className="list-inside list-disc space-y-1 text-sm">
                    {expl.remediation.map((r, i) => <li key={i}>{r}</li>)}
                  </ul>
                </Section>
                <Section title="Commandes utiles">
                  <div className="space-y-2">
                    {expl.commands.map((c, i) => (
                      <pre key={i} className="overflow-x-auto rounded-lg border border-line bg-surface-2 px-3 py-2 font-mono text-xs">
                        {c}
                      </pre>
                    ))}
                  </div>
                </Section>
                <Section title="Références">
                  <ul className="space-y-1 text-sm">
                    {expl.references.map((r, i) => (
                      <li key={i}>
                        <a href={r} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                          {r}
                        </a>
                      </li>
                    ))}
                  </ul>
                </Section>
              </>
            )}
          </div>
        )}
      </aside>
    </>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {children}
    </div>
  );
}
