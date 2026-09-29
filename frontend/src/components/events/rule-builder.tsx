"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { createRule, previewRule, runDetection, type CustomRule, type RuleInput, type RulePreview } from "@/lib/api";
import { channelLabel, fmtDateTime } from "@/lib/events-ui";
import type { RuleLevel, RuleSeed } from "@/lib/rule-seed";

const LEVELS: { key: RuleLevel; label: string; tone: string }[] = [
  { key: "critical", label: "Critique", tone: "critical" },
  { key: "high", label: "Haute", tone: "warn" },
  { key: "medium", label: "Moyenne", tone: "accent" },
  { key: "low", label: "Faible", tone: "muted" },
];
const MITRE = /^T\d{4}(\.\d{3})?$/;
const MAX_KEYWORDS = 10;

interface RuleBuilderProps {
  seed: RuleSeed | null;
  onClose: () => void;
}

/**
 * Constructeur de règle (tiroir) : part d'un événement réel ou d'une recherche, montre ce que la
 * règle AURAIT trouvé avant de l'enregistrer, puis propose de lancer la détection.
 * Monté avec une `key` par graine : chaque ouverture repart d'un formulaire propre.
 */
export function RuleBuilder({ seed, onClose }: RuleBuilderProps) {
  useEffect(() => {
    if (!seed) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [seed, onClose]);

  return (
    <>
      <div onClick={onClose} aria-hidden className={`fixed inset-0 z-[70] bg-black/55 transition-opacity ${seed ? "opacity-100" : "pointer-events-none opacity-0"}`} />
      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Nouvelle règle de détection"
        className={`fixed inset-y-0 right-0 z-[80] flex w-full max-w-xl flex-col border-l border-line bg-surface shadow-2xl transition-transform duration-300 ${seed ? "translate-x-0" : "translate-x-full"}`}
      >
        {seed && <BuilderForm key={`${seed.origin}:${seed.title}`} seed={seed} onClose={onClose} />}
      </aside>
    </>
  );
}

function BuilderForm({ seed, onClose }: { seed: RuleSeed; onClose: () => void }) {
  const [title, setTitle] = useState(seed.title);
  const [useChannel, setUseChannel] = useState(seed.channel !== null);
  const [useEventId, setUseEventId] = useState(seed.eventId !== null);
  const [keywords, setKeywords] = useState<string[]>(seed.keywords);
  const [typed, setTyped] = useState("");
  const [level, setLevel] = useState<RuleLevel>(seed.level);
  const [mitre, setMitre] = useState(seed.mitre ?? "");
  const [description, setDescription] = useState(seed.description);
  const [threshold, setThreshold] = useState(false);
  const [count, setCount] = useState(5);
  const [minutes, setMinutes] = useState(10);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<CustomRule | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [run, setRun] = useState<{ busy: boolean; text: string | null }>({ busy: false, text: null });

  const input: RuleInput = useMemo(
    () => ({
      title: title.trim(),
      level,
      description: description.trim() || undefined,
      mitre: MITRE.test(mitre.trim()) ? mitre.trim() : undefined,
      channel: useChannel && seed.channel ? seed.channel : undefined,
      event_id: useEventId ? seed.eventId : null,
      keywords,
      threshold_count: threshold ? count : null,
      threshold_minutes: threshold ? minutes : null,
    }),
    [title, level, description, mitre, useChannel, useEventId, keywords, threshold, count, minutes, seed],
  );
  const hasCriteria = keywords.length > 0 || Boolean(input.channel) || input.event_id !== null;

  // Aperçu en direct (différé de 400 ms, requête précédente annulée).
  const previewKey = JSON.stringify({ ...input, title: "", description: "" });
  const [preview, setPreview] = useState<{ key: string; data: RulePreview | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!hasCriteria) return;
    const ctrl = new AbortController();
    const t = window.setTimeout(() => {
      previewRule({ ...input, title: input.title.length >= 3 ? input.title : "Aperçu" }, ctrl.signal)
        .then((data) => setPreview({ key: previewKey, data, error: null }))
        .catch((e) => !ctrl.signal.aborted && setPreview({ key: previewKey, data: null, error: e instanceof Error ? e.message : "Aperçu impossible" }));
    }, 400);
    return () => {
      window.clearTimeout(t);
      ctrl.abort();
    };
  }, [previewKey, hasCriteria, input]);
  const previewing = hasCriteria && preview?.key !== previewKey;
  const data = hasCriteria ? preview?.data ?? null : null;

  function addKeyword(k: string) {
    const v = k.trim();
    if (v.length < 2 || v.length > 200 || keywords.length >= MAX_KEYWORDS || keywords.some((x) => x.toLowerCase() === v.toLowerCase())) return;
    setKeywords([...keywords, v]);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      setSaved(await createRule(input));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Création impossible");
    } finally {
      setSaving(false);
    }
  }

  async function runNow() {
    setRun({ busy: true, text: null });
    try {
      const r = await runDetection();
      setRun({ busy: false, text: `${r.rules_run} règles exécutées, ${r.alerts_created} nouvelle(s) alerte(s).` });
    } catch (e) {
      setRun({ busy: false, text: e instanceof Error ? e.message : "Détection impossible" });
    }
  }

  const btn = "rounded-lg border border-line px-3 py-1.5 text-xs transition hover:border-accent/60 hover:text-accent disabled:opacity-40";

  if (saved) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
        <span className="grid h-14 w-14 place-items-center rounded-full bg-accent/15 text-2xl text-accent">✓</span>
        <div>
          <p className="text-base font-semibold">Règle créée</p>
          <p className="mt-1 text-sm text-muted">
            « {saved.title} » · <span className="font-mono">{saved.rule_id}</span>
          </p>
          <p className="mt-2 text-xs text-muted">Elle s&apos;appliquera à chaque exécution du moteur de détection.</p>
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <button onClick={runNow} disabled={run.busy} className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50">
            {run.busy ? "Analyse…" : "Lancer la détection maintenant"}
          </button>
          <Link href="/dashboard/rules" className={btn}>
            Voir les règles
          </Link>
          <button onClick={onClose} className={btn}>
            Fermer
          </button>
        </div>
        {run.text && <p className="text-sm text-accent">{run.text}</p>}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-start justify-between gap-3 border-b border-line px-5 py-4">
        <div className="min-w-0">
          <p className="eyebrow">Nouvelle règle de détection</p>
          <p className="mt-0.5 truncate text-xs text-muted" title={seed.origin}>
            Depuis : {seed.origin}
          </p>
        </div>
        <button onClick={onClose} className="rounded-lg border border-line px-2 py-1 text-muted transition hover:text-foreground" aria-label="Fermer">
          ✕
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4 text-sm">
        <Field label="Titre">
          <input value={title} onChange={(e) => setTitle(e.target.value.slice(0, 255))} className="w-full rounded-lg border border-line bg-surface-2 px-3 py-2 outline-none focus:border-accent" />
        </Field>

        <Field label="Portée" hint="Tous les critères cochés doivent être vrais.">
          <div className="flex flex-wrap gap-2">
            {seed.channel && (
              <Toggle on={useChannel} onClick={() => setUseChannel((v) => !v)}>
                Journal : {channelLabel(seed.channel)}
              </Toggle>
            )}
            {seed.eventId !== null && (
              <Toggle on={useEventId} onClick={() => setUseEventId((v) => !v)}>
                Event ID <span className="font-mono">{seed.eventId}</span>
              </Toggle>
            )}
            {!seed.channel && seed.eventId === null && <span className="text-xs text-muted">Tous les journaux.</span>}
          </div>
        </Field>

        <Field label="Mots-clés" hint="Au moins un doit figurer dans le message (littéral, sans tenir compte de la casse).">
          <div className="flex flex-wrap gap-1.5">
            {keywords.map((k) => (
              <span key={k} className="flex max-w-full items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 px-2.5 py-0.5 font-mono text-[11px] text-accent">
                <span className="truncate">{k}</span>
                <button onClick={() => setKeywords(keywords.filter((x) => x !== k))} className="text-muted hover:text-foreground" aria-label={`Retirer ${k}`}>
                  ✕
                </button>
              </span>
            ))}
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value.slice(0, 200))}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addKeyword(typed);
                  setTyped("");
                }
              }}
              placeholder={keywords.length >= MAX_KEYWORDS ? "10 mots-clés maximum" : "Ajouter (Entrée)…"}
              disabled={keywords.length >= MAX_KEYWORDS}
              className="min-w-40 flex-1 rounded-lg border border-line bg-surface-2 px-2.5 py-1 font-mono text-[11px] outline-none focus:border-accent"
            />
          </div>
          {seed.suggestions.filter((s) => !keywords.includes(s)).length > 0 && (
            <div className="mt-2">
              <p className="mb-1 text-[10px] uppercase tracking-wide text-muted">Suggestions tirées de l&apos;événement</p>
              <div className="flex flex-wrap gap-1.5">
                {seed.suggestions
                  .filter((s) => !keywords.includes(s))
                  .map((s) => (
                    <button key={s} onClick={() => addKeyword(s)} className="max-w-full truncate rounded-full border border-dashed border-line px-2.5 py-0.5 font-mono text-[11px] text-muted transition hover:border-accent/60 hover:text-accent">
                      + {s}
                    </button>
                  ))}
              </div>
            </div>
          )}
        </Field>

        <div className="grid grid-cols-[1fr_auto] gap-4">
          <Field label="Sévérité">
            <div className="flex gap-1">
              {LEVELS.map((l) => (
                <button
                  key={l.key}
                  onClick={() => setLevel(l.key)}
                  aria-pressed={level === l.key}
                  className={`rounded-lg border px-2.5 py-1 text-xs transition ${level === l.key ? "font-semibold" : "border-line text-muted hover:text-foreground"}`}
                  style={level === l.key ? { color: `var(--${l.tone})`, borderColor: `var(--${l.tone})`, backgroundColor: `color-mix(in srgb, var(--${l.tone}) 12%, transparent)` } : undefined}
                >
                  {l.label}
                </button>
              ))}
            </div>
          </Field>
          <Field label="MITRE ATT&CK">
            <input
              value={mitre}
              onChange={(e) => setMitre(e.target.value.toUpperCase().slice(0, 9))}
              placeholder="T1078"
              className={`w-24 rounded-lg border bg-surface-2 px-2.5 py-1 font-mono text-xs outline-none focus:border-accent ${mitre && !MITRE.test(mitre) ? "border-warn" : "border-line"}`}
            />
          </Field>
        </div>

        <Field label="Seuil" hint="Sans seuil : une alerte par événement correspondant.">
          <label className="flex flex-wrap items-center gap-2 text-xs">
            <input type="checkbox" checked={threshold} onChange={(e) => setThreshold(e.target.checked)} className="accent-[var(--accent)]" />
            Alerter seulement si
            <input type="number" min={1} max={100000} value={count} disabled={!threshold} onChange={(e) => setCount(Math.max(1, Math.min(100000, Number(e.target.value) || 1)))} className="w-16 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono disabled:opacity-40" />
            fois en
            <input type="number" min={1} max={10080} value={minutes} disabled={!threshold} onChange={(e) => setMinutes(Math.max(1, Math.min(10080, Number(e.target.value) || 1)))} className="w-16 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 font-mono disabled:opacity-40" />
            minutes
          </label>
        </Field>

        <Field label="Description">
          <textarea value={description} onChange={(e) => setDescription(e.target.value.slice(0, 2000))} rows={3} className="w-full resize-none rounded-lg border border-line bg-surface-2 px-3 py-2 text-xs outline-none focus:border-accent" />
        </Field>
      </div>

      {/* Aperçu : ce que la règle aurait trouvé */}
      <div className="border-t border-line bg-surface-2/40 px-5 py-3">
        {!hasCriteria ? (
          <p className="text-xs text-warn">Choisissez au moins un critère : journal, Event ID ou mot-clé.</p>
        ) : preview?.error && !previewing ? (
          <p className="text-xs text-critical">{preview.error}</p>
        ) : (
          <div className={previewing ? "opacity-50" : ""}>
            <div className="flex items-end gap-5">
              <Metric label="24 h" value={data?.matches_24h} />
              <Metric label="7 jours" value={data?.matches_7d} />
              <Metric label={threshold ? "alerte (seuil atteint ?)" : "alertes à la prochaine exécution"} value={data?.would_alert} />
              {data?.noisy && <span className="mb-1 rounded-full bg-warn/15 px-2 py-0.5 text-[11px] font-medium text-warn">trop bruyante : affinez</span>}
              {data && data.matches_7d === 0 && <span className="mb-1 text-[11px] text-muted">rien sur 7 jours</span>}
            </div>
            {data && data.samples.length > 0 && (
              <ul className="mt-2 space-y-0.5 text-[11px]">
                {data.samples.map((s) => (
                  <li key={s.id} className="flex gap-2 truncate">
                    <span className="shrink-0 font-mono text-muted">{fmtDateTime(s.timestamp)}</span>
                    <span className="truncate">{s.summary ?? s.title ?? s.message}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && <p className="mt-2 text-xs text-critical">{error}</p>}
        <div className="mt-3 flex justify-end gap-2">
          <button onClick={onClose} className={btn}>
            Annuler
          </button>
          <button
            onClick={save}
            disabled={saving || !hasCriteria || input.title.length < 3 || (mitre !== "" && !MITRE.test(mitre))}
            className="rounded-lg bg-accent px-4 py-1.5 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-40"
          >
            {saving ? "Création…" : "Créer la règle"}
          </button>
        </div>
      </div>
    </>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      {children}
      {hint && <p className="mt-1 text-[11px] text-muted">{hint}</p>}
    </div>
  );
}

function Toggle({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button onClick={onClick} aria-pressed={on} className={`flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition ${on ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted line-through"}`}>
      <span className="font-mono">{on ? "☑" : "☐"}</span>
      {children}
    </button>
  );
}

function Metric({ label, value }: { label: string; value: number | undefined }) {
  return (
    <div>
      <p className="font-mono text-xl font-semibold tabular-nums leading-none">{value === undefined ? "…" : value.toLocaleString("fr-FR")}</p>
      <p className="mt-0.5 text-[10px] text-muted">{label}</p>
    </div>
  );
}
