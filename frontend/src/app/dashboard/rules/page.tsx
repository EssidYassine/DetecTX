"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { deleteRule, fetchCustomRules, toggleRule, type CustomRule } from "@/lib/api";
import { channelLabel } from "@/lib/events-ui";
import { EmptyState, SeverityBadge } from "@/components/ui";

const STEPS = [
  { n: 1, title: "Ouvrez les journaux", text: "Trouvez l'événement qui vous intéresse, ou lancez une recherche." },
  { n: 2, title: "« Créer une règle »", text: "Depuis le lecteur d'événement, ou « En faire une règle » depuis la recherche." },
  { n: 3, title: "Vérifiez l'aperçu", text: "Combien d'événements elle aurait trouvés sur 24 h et 7 jours, avant d'enregistrer." },
];

export default function RulesPage() {
  const [rules, setRules] = useState<CustomRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await fetchCustomRules());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Lecture des règles impossible");
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetchCustomRules()
      .then((r) => !cancelled && setRules(r))
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : "Lecture des règles impossible"));
    return () => {
      cancelled = true;
    };
  }, []);

  async function act(fn: () => Promise<unknown>) {
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Action impossible");
    }
  }

  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Règles de détection</h1>
        <p className="text-sm text-muted">Vos règles s&apos;ajoutent au moteur (règles internes + SigmaHQ) à chaque exécution de la détection.</p>
      </div>

      {/* Créer : toujours à partir de données réelles */}
      <section className="flex flex-wrap items-center gap-6 rounded-2xl border border-accent/30 bg-accent/5 p-5">
        <div className="min-w-0 flex-1">
          <p className="font-medium">Une règle se crée à partir de ce que la machine a réellement enregistré.</p>
          <ol className="mt-3 grid gap-3 sm:grid-cols-3">
            {STEPS.map((s) => (
              <li key={s.n} className="flex gap-2.5">
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-accent/15 font-mono text-xs text-accent">{s.n}</span>
                <span className="text-sm">
                  <span className="block font-medium">{s.title}</span>
                  <span className="text-xs text-muted">{s.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
        <Link href="/dashboard/events" className="shrink-0 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-fg transition hover:brightness-110">
          Créer depuis les journaux →
        </Link>
      </section>

      <section className="rounded-2xl border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 font-medium">Mes règles ({rules?.length ?? "…"})</h2>
        {error && <p className="px-5 py-3 text-sm text-critical">{error}</p>}
        {rules && rules.length === 0 ? (
          <EmptyState>Aucune règle personnalisée pour l&apos;instant.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">État</th>
                <th className="px-3 py-2.5 font-medium">Titre</th>
                <th className="px-3 py-2.5 font-medium">Sévérité</th>
                <th className="px-3 py-2.5 font-medium">Critères</th>
                <th className="px-3 py-2.5 text-right font-medium">Alertes</th>
                <th className="px-5 py-2.5 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(rules ?? []).map((r) => (
                <tr key={r.id} className="border-b border-line/50 hover:bg-surface-2">
                  <td className="px-5 py-2.5">
                    <button
                      onClick={() => act(() => toggleRule(r.id))}
                      className="rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{ color: `var(--${r.enabled ? "accent" : "muted"})`, backgroundColor: `color-mix(in srgb, var(--${r.enabled ? "accent" : "muted"}) 15%, transparent)` }}
                    >
                      {r.enabled ? "Activée" : "Désactivée"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="block font-medium">{r.title}</span>
                    <span className="font-mono text-[11px] text-muted">
                      {r.rule_id}
                      {r.mitre && <span className="ml-2 text-accent">{r.mitre}</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    <SeverityBadge severity={r.level} />
                  </td>
                  <td className="max-w-sm px-3 py-2.5 text-xs text-muted">
                    <span className="block truncate">
                      {[r.channel && channelLabel(r.channel), r.event_id !== null && `ID ${r.event_id}`].filter(Boolean).join(" · ") || "Tous les journaux"}
                    </span>
                    {r.keywords.length > 0 && <span className="block truncate font-mono">{r.keywords.join(" | ")}</span>}
                    {r.threshold_count && <span className="block">seuil : {r.threshold_count} fois / {r.threshold_minutes} min</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                    {r.alerts > 0 ? (
                      <Link href={`/dashboard/alerts?case=${encodeURIComponent(r.rule_id)}`} className="text-accent hover:underline">
                        {r.alerts}
                      </Link>
                    ) : (
                      <span className="text-muted">0</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-5 py-2.5 text-right text-xs">
                    {confirm === r.id ? (
                      <>
                        <button onClick={() => act(() => deleteRule(r.id)).then(() => setConfirm(null))} className="mr-3 font-medium text-critical">
                          Confirmer
                        </button>
                        <button onClick={() => setConfirm(null)} className="text-muted hover:text-foreground">
                          Annuler
                        </button>
                      </>
                    ) : (
                      <button onClick={() => setConfirm(r.id)} className="text-muted transition hover:text-critical">
                        Supprimer
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}
