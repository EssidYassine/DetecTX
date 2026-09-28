"use client";

import { useEffect, useState, type ReactNode } from "react";
import { explainAlert, searchAlerts, type Alert, type AlertCase, type Explanation, type TriageInput } from "@/lib/api";
import { fmtWhen, isOpen, SEVERITY_LABEL, SEVERITY_TONE, tacticLabel } from "@/lib/cases";
import { channelLabel } from "@/lib/events-ui";
import { RESOLUTION_LABEL, RESOLUTIONS, STATUS_LABEL, STATUS_TONE } from "@/lib/triage";
import { fmtAgo } from "@/lib/time";
import { StatusPill, TriageActions } from "@/components/triage-actions";

type Tab = "analysis" | "occurrences";

interface CaseDetailProps {
  c: AlertCase | null;
  now: number;
  refreshKey: number;
  /** Triage du dossier entier ; résout quand le serveur a répondu. */
  onTriage: (ruleId: string, input: TriageInput) => Promise<void>;
  onTriaged: () => void;
  busy: boolean;
  className?: string;
}

/** Fiche d'un dossier : ce qui s'est passé, pourquoi c'est grave, quoi faire, et la décision. */
export function CaseDetail({ c, now, refreshKey, onTriage, onTriaged, busy, className = "" }: CaseDetailProps) {
  const [tab, setTab] = useState<Tab>("analysis");
  const [closing, setClosing] = useState(false);

  if (!c) {
    return (
      <div className={`panel flex min-h-0 flex-col items-center justify-center p-8 text-center ${className}`}>
        <p className="text-sm font-medium">Aucun dossier sélectionné</p>
        <p className="mt-1 text-xs text-muted">Choisissez un dossier dans la file ou un cristal du radar.</p>
      </div>
    );
  }

  const open = isOpen(c);
  const tone = open ? SEVERITY_TONE[c.severity] : "muted";
  const btn = "rounded-lg border border-line px-3 py-1.5 text-xs transition hover:border-accent/60 hover:text-accent disabled:opacity-50";

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      {/* En-tête : jauge de risque + identité de la détection */}
      <div className="flex items-start gap-4 border-b border-line px-4 py-3">
        <RiskGauge value={c.risk} tone={tone} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span className="rounded px-1.5 py-px font-semibold uppercase tracking-wide" style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}>
              {SEVERITY_LABEL[c.severity]}
            </span>
            {c.mitre && <span className="font-mono text-accent">{c.mitre}</span>}
            <span className="text-muted">{c.mitre_name ?? tacticLabel(c.tactic)}</span>
          </div>
          <h2 className="mt-1 text-base font-semibold leading-snug">{c.rule_title}</h2>
          <p className="mt-0.5 text-[11px] text-muted">Tactique : {c.tactic_fr ?? tacticLabel(c.tactic)}</p>
        </div>
      </div>

      {/* Faits clés */}
      <dl className="grid grid-cols-4 divide-x divide-line border-b border-line text-center">
        <Fact label="Occurrences" value={`×${c.count}`} />
        <Fact label="Première" value={fmtWhen(c.first_seen)} small />
        <Fact label="Dernière" value={fmtAgo(c.last_seen, now)} small />
        <Fact label="Ouvertes" value={`${c.by_status.new + c.by_status.ack}/${c.count}`} tone={open ? "accent" : "muted"} />
      </dl>

      {/* Décision sur le dossier entier */}
      <div className="space-y-2 border-b border-line px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          {(["new", "ack", "closed"] as const).map((s) =>
            c.by_status[s] ? (
              <span key={s} className="rounded-full border px-2 py-0.5 text-[11px]" style={{ color: `var(--${STATUS_TONE[s]})`, borderColor: `color-mix(in srgb, var(--${STATUS_TONE[s]}) 40%, transparent)` }}>
                {c.by_status[s]} {STATUS_LABEL[s].toLowerCase()}
                {c.by_status[s] > 1 ? "s" : ""}
              </span>
            ) : null,
          )}
          <span className="ml-auto text-[10px] text-muted">{c.channels.map(channelLabel).join(" · ")}</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {c.by_status.new > 0 && (
            <button disabled={busy} onClick={() => void onTriage(c.rule_id, { status: "ack" })} className={btn}>
              Prendre en charge ({c.by_status.new})
            </button>
          )}
          {open && (
            <button disabled={busy} onClick={() => setClosing((v) => !v)} className={btn} aria-expanded={closing}>
              Clôturer le dossier ▾
            </button>
          )}
          {c.by_status.ack + c.by_status.closed > 0 && (
            <button disabled={busy} onClick={() => void onTriage(c.rule_id, { status: "new" })} className={btn}>
              Rouvrir
            </button>
          )}
        </div>
        {closing && open && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-muted">Conclusion pour les {c.by_status.new + c.by_status.ack} alerte(s) ouverte(s) :</span>
            {RESOLUTIONS.map((r) => (
              <button
                key={r}
                disabled={busy}
                onClick={() => void onTriage(c.rule_id, { status: "closed", resolution: r }).then(() => setClosing(false))}
                className={`${btn} ${r === "true_positive" ? "hover:!border-critical/60 hover:!text-critical" : ""}`}
              >
                {RESOLUTION_LABEL[r]}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="flex gap-1 border-b border-line px-3 py-1.5" role="tablist" aria-label="Contenu du dossier">
        {(
          [
            ["analysis", "Analyse"],
            ["occurrences", `Occurrences (${c.count})`],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`rounded-lg px-2.5 py-1 text-xs transition ${tab === key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-sm">
        {tab === "analysis" ? (
          <Analysis alertId={c.latest_id} />
        ) : (
          <Occurrences ruleId={c.rule_id} refreshKey={refreshKey} now={now} onTriaged={onTriaged} />
        )}
      </div>
    </div>
  );
}

function RiskGauge({ value, tone }: { value: number; tone: string }) {
  const r = 22;
  const len = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="relative h-14 w-14 shrink-0" title={`Risque ${v}/100`}>
      <svg viewBox="0 0 56 56" className="h-full w-full -rotate-90">
        <circle cx="28" cy="28" r={r} fill="none" stroke="var(--line)" strokeWidth="5" />
        <circle cx="28" cy="28" r={r} fill="none" stroke={`var(--${tone})`} strokeWidth="5" strokeLinecap="round" strokeDasharray={`${(v / 100) * len} ${len}`} />
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center leading-none">
        <span className="font-mono text-base font-semibold tabular-nums">{v}</span>
        <span className="text-[8px] uppercase tracking-wide text-muted">risque</span>
      </span>
    </div>
  );
}

function Fact({ label, value, tone, small }: { label: string; value: string; tone?: string; small?: boolean }) {
  return (
    <div className="px-2 py-2">
      <dt className="text-[10px] uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-0.5 font-mono tabular-nums ${small ? "text-[11px]" : "text-sm font-semibold"}`} style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </dd>
    </div>
  );
}

/** Explication (analyse intégrée ou IA) de la dernière occurrence : chaque affirmation cite sa source. */
function Analysis({ alertId }: { alertId: number }) {
  const [state, setState] = useState<{ id: number; expl: Explanation | null; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    explainAlert(alertId)
      .then((expl) => !cancelled && setState({ id: alertId, expl, error: null }))
      .catch((e) => !cancelled && setState({ id: alertId, expl: null, error: e instanceof Error ? e.message : "Analyse indisponible" }));
    return () => {
      cancelled = true;
    };
  }, [alertId]);

  if (state?.id !== alertId) return <p className="text-xs text-muted">Analyse de la dernière occurrence…</p>;
  if (state.error || !state.expl) return <p className="text-xs text-critical">{state.error}</p>;
  const e = state.expl;
  return (
    <div className="space-y-4">
      <p className="flex flex-wrap items-center gap-2 text-[11px] text-muted">
        <span className="rounded-full border border-line px-2 py-0.5">{e.source === "builtin" ? "Analyse intégrée" : `IA · ${e.source}`}</span>
        <span>source : alerte n° {e.alert_id} (dernière occurrence)</span>
      </p>
      {e.ai_narrative && (
        <Section title="Synthèse IA">
          <p className="whitespace-pre-wrap leading-relaxed">{e.ai_narrative}</p>
        </Section>
      )}
      <Section title="Ce qui s'est passé">
        <p className="leading-relaxed">{e.description}</p>
      </Section>
      <Section title="Cause probable">
        <p className="leading-relaxed text-muted">{e.cause}</p>
      </Section>
      <Section title="Impact">
        <p className="leading-relaxed">{e.impact}</p>
      </Section>
      <Section title="Que faire">
        <ol className="space-y-1.5">
          {e.remediation.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent/15 font-mono text-[10px] text-accent">{i + 1}</span>
              <span className="leading-relaxed">{r}</span>
            </li>
          ))}
        </ol>
      </Section>
      {e.commands.length > 0 && (
        <Section title="Commandes de vérification">
          <div className="space-y-1.5">
            {e.commands.map((cmd, i) => (
              <CopyLine key={i} text={cmd} />
            ))}
          </div>
        </Section>
      )}
      {e.references.length > 0 && (
        <Section title="Références">
          <ul className="space-y-1 text-xs">
            {e.references.map((r) => (
              <li key={r} className="truncate">
                <a href={r} target="_blank" rel="noreferrer noopener" className="text-accent hover:underline">
                  {r}
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** Toutes les alertes du dossier ; chacune peut être triée individuellement. */
function Occurrences({ ruleId, refreshKey, now, onTriaged }: { ruleId: string; refreshKey: number; now: number; onTriaged: () => void }) {
  const key = `${ruleId}:${refreshKey}`;
  const [state, setState] = useState<{ key: string; items: Alert[]; total: number; error: string | null } | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    searchAlerts({ ruleId, limit: 100 })
      .then((p) => !cancelled && setState({ key, items: p.items, total: p.total, error: null }))
      .catch((e) => !cancelled && setState({ key, items: [], total: 0, error: e instanceof Error ? e.message : "Erreur" }));
    return () => {
      cancelled = true;
    };
  }, [key, ruleId]);

  if (!state || !state.key.startsWith(`${ruleId}:`)) return <p className="text-xs text-muted">Chargement des occurrences…</p>;
  if (state.error) return <p className="text-xs text-critical">{state.error}</p>;
  const items = [...state.items].sort((a, b) => (b.event_timestamp ?? b.created_at).localeCompare(a.event_timestamp ?? a.created_at));
  return (
    <div>
      {state.total > items.length && <p className="mb-2 text-[11px] text-muted">{items.length} plus récentes sur {state.total}.</p>}
      <ol className="relative space-y-1 border-l border-line pl-4">
        {items.map((a) => (
          <li key={a.id} className="relative">
            <span className="absolute -left-[21px] top-2.5 h-2 w-2 rounded-full" style={{ backgroundColor: `var(--${STATUS_TONE[a.status]})` }} aria-hidden="true" />
            <button onClick={() => setExpanded(expanded === a.id ? null : a.id)} aria-expanded={expanded === a.id} className="w-full rounded-lg px-2 py-1.5 text-left transition hover:bg-surface-2">
              <span className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-mono tabular-nums text-muted">
                  {fmtWhen(a.event_timestamp ?? a.created_at)} · {fmtAgo(a.event_timestamp ?? a.created_at, now)}
                </span>
                <StatusPill alert={a} />
              </span>
              <span className="mt-0.5 block truncate font-mono text-[11px]">{a.message ?? "—"}</span>
            </button>
            {expanded === a.id && (
              <div className="mb-2 space-y-2 px-2">
                {a.message && <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface-2 p-2 font-mono text-[11px]">{a.message}</pre>}
                <p className="text-[11px] text-muted">
                  Alerte n° {a.id} · {a.channel ? channelLabel(a.channel) : "journal inconnu"}
                  {a.event_id !== null && ` · Event ID ${a.event_id}`}
                </p>
                <TriageActions alert={a} onChanged={onTriaged} />
              </div>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}

function CopyLine({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-start gap-2 rounded-lg border border-line bg-surface-2 px-2.5 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{text}</code>
      <button
        onClick={() =>
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1500);
          })
        }
        className="shrink-0 text-[11px] text-accent hover:underline"
      >
        {copied ? "copié" : "copier"}
      </button>
    </div>
  );
}
