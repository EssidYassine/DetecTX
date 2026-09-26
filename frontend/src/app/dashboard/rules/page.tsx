"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createRule,
  deleteRule,
  fetchCustomRules,
  toggleRule,
  type CustomRule,
  type RuleInput,
} from "@/lib/api";
import { EmptyState, SeverityBadge } from "@/components/ui";

const CHANNELS = [
  { value: "", label: "Tous les canaux" },
  { value: "Security", label: "Security" },
  { value: "System", label: "System" },
  { value: "Application", label: "Application" },
  { value: "Microsoft-Windows-Sysmon/Operational", label: "Sysmon" },
  { value: "Microsoft-Windows-PowerShell/Operational", label: "PowerShell" },
  { value: "DeTecTX-FileMonitor", label: "Activité fichiers" },
];

const EMPTY: RuleInput = { title: "", level: "medium", keywords: [] };

export default function RulesPage() {
  const [rules, setRules] = useState<CustomRule[]>([]);
  const [form, setForm] = useState({
    title: "",
    level: "medium",
    mitre: "",
    channel: "",
    keywords: "",
    threshold_count: "",
    threshold_minutes: "",
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setRules(await fetchCustomRules().catch(() => []));
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaving(true);
    try {
      const input: RuleInput = {
        ...EMPTY,
        title: form.title,
        level: form.level,
        mitre: form.mitre || undefined,
        channel: form.channel || undefined,
        keywords: form.keywords.split(",").map((k) => k.trim()).filter(Boolean),
        threshold_count: form.threshold_count ? Number(form.threshold_count) : null,
        threshold_minutes: form.threshold_minutes ? Number(form.threshold_minutes) : null,
      };
      await createRule(input);
      setForm({ title: "", level: "medium", mitre: "", channel: "", keywords: "", threshold_count: "", threshold_minutes: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erreur");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Règles de détection</h1>
        <p className="text-sm text-muted">
          Créez vos propres règles — elles s’ajoutent au moteur (interne + SigmaHQ) au prochain scan.
        </p>
      </div>

      {/* Formulaire de création */}
      <form onSubmit={submit} className="rounded-2xl border border-line bg-surface p-5">
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Titre de la règle *">
            <input required value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="Ex. Exécution de whoami" className={inputCls} />
          </Field>
          <Field label="Mots-clés (séparés par des virgules)">
            <input value={form.keywords} onChange={(e) => setForm({ ...form, keywords: e.target.value })}
              placeholder="whoami, net user, mimikatz" className={inputCls} />
          </Field>
          <Field label="Sévérité">
            <select value={form.level} onChange={(e) => setForm({ ...form, level: e.target.value })} className={inputCls}>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
          </Field>
          <Field label="Technique MITRE (optionnel)">
            <input value={form.mitre} onChange={(e) => setForm({ ...form, mitre: e.target.value })}
              placeholder="T1059.001" className={inputCls} />
          </Field>
          <Field label="Canal (optionnel)">
            <select value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })} className={inputCls}>
              {CHANNELS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="Seuil (optionnel) : N occurrences / M minutes">
            <div className="flex gap-2">
              <input type="number" min={1} value={form.threshold_count} onChange={(e) => setForm({ ...form, threshold_count: e.target.value })}
                placeholder="N" className={inputCls} />
              <input type="number" min={1} value={form.threshold_minutes} onChange={(e) => setForm({ ...form, threshold_minutes: e.target.value })}
                placeholder="min" className={inputCls} />
            </div>
          </Field>
        </div>
        {error && <p className="mt-3 text-sm text-critical">{error}</p>}
        <button type="submit" disabled={saving}
          className="mt-4 rounded-lg bg-accent px-5 py-2.5 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50">
          {saving ? "Création…" : "Créer la règle"}
        </button>
      </form>

      {/* Liste */}
      <section className="rounded-2xl border border-line bg-surface">
        <h2 className="border-b border-line px-5 py-3 font-medium">Mes règles ({rules.length})</h2>
        {rules.length === 0 ? (
          <EmptyState>Aucune règle personnalisée. Créez-en une ci-dessus.</EmptyState>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs uppercase tracking-wide text-muted">
              <tr className="border-b border-line">
                <th className="px-5 py-2.5 font-medium">État</th>
                <th className="px-3 py-2.5 font-medium">Titre</th>
                <th className="px-3 py-2.5 font-medium">Sévérité</th>
                <th className="px-3 py-2.5 font-medium">MITRE</th>
                <th className="px-3 py-2.5 font-medium">Critères</th>
                <th className="px-5 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-b border-line/50 hover:bg-surface-2">
                  <td className="px-5 py-2.5">
                    <button
                      onClick={async () => { await toggleRule(r.id); await load(); }}
                      className="rounded-full px-2 py-0.5 text-xs font-medium"
                      style={{
                        color: `var(--${r.enabled ? "ok" : "muted"})`,
                        backgroundColor: `color-mix(in srgb, var(--${r.enabled ? "ok" : "muted"}) 15%, transparent)`,
                      }}
                    >
                      {r.enabled ? "Activée" : "Désactivée"}
                    </button>
                  </td>
                  <td className="px-3 py-2.5">{r.title}</td>
                  <td className="px-3 py-2.5"><SeverityBadge severity={r.level} /></td>
                  <td className="px-3 py-2.5 font-mono text-xs text-accent">{r.mitre ?? "—"}</td>
                  <td className="max-w-xs truncate px-3 py-2.5 text-xs text-muted">
                    {r.keywords.length ? r.keywords.join(", ") : ""}
                    {r.channel ? ` · ${r.channel}` : ""}
                    {r.threshold_count ? ` · seuil ${r.threshold_count}/${r.threshold_minutes}min` : ""}
                  </td>
                  <td className="px-5 py-2.5 text-right">
                    <button
                      onClick={async () => { await deleteRule(r.id); await load(); }}
                      className="text-xs text-muted transition hover:text-critical"
                    >
                      Supprimer
                    </button>
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

const inputCls =
  "w-full rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent focus:ring-1 focus:ring-accent";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm text-muted">{label}</span>
      {children}
    </label>
  );
}
