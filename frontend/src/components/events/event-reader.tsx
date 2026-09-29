"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchEventDetail, type EventDetail } from "@/lib/api";
import { channelLabel, fmtDateTime, INTEREST_LABEL, INTEREST_TONE } from "@/lib/events-ui";
import { seedFromEvent, type RuleSeed } from "@/lib/rule-seed";

const SEVERITY_TONE: Record<string, string> = { critical: "critical", high: "warn", medium: "warn", low: "accent" };
const STATUS_LABEL: Record<string, string> = { new: "nouvelle", ack: "prise en charge", closed: "clôturée" };

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span className="rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}>
      {children}
    </span>
  );
}

/** Lecteur d'événement : ce qui s'est passé, pourquoi c'est important, ce que ça a déclenché. */
export function EventReader({
  eventId,
  onClose,
  onCreateRule,
  className = "",
}: {
  eventId: string | null;
  onClose: () => void;
  /** Ouvre le constructeur de règle pré-rempli avec cet événement. */
  onCreateRule?: (seed: RuleSeed) => void;
  className?: string;
}) {
  const [state, setState] = useState<{ id: string; detail: EventDetail | null; error: string | null } | null>(null);
  const [copied, setCopied] = useState(false);
  const loading = eventId !== null && state?.id !== eventId;

  useEffect(() => {
    if (eventId === null) return;
    let cancelled = false;
    fetchEventDetail(eventId)
      .then((detail) => !cancelled && setState({ id: eventId, detail, error: null }))
      .catch((e) => !cancelled && setState({ id: eventId, detail: null, error: e instanceof Error ? e.message : "Lecture impossible" }));
    return () => {
      cancelled = true;
    };
  }, [eventId]);

  const detail = !loading && state?.id === eventId ? state.detail : null;
  const k = detail?.knowledge ?? null;
  const fields = detail ? Object.entries(detail.fields).filter(([, v]) => v !== null && v !== "") : [];

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Lecteur d&apos;événement</span>
        {eventId && (
          <button onClick={onClose} className="text-muted transition hover:text-foreground" aria-label="Fermer le lecteur">
            ✕
          </button>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
        {eventId === null && <p className="text-muted">Choisissez un événement dans la liste — ou un relief, puis un événement — pour le lire en clair.</p>}
        {loading && <p className="text-muted">Lecture…</p>}
        {state?.error && state.id === eventId && <p className="text-critical">{state.error}</p>}
        {detail && (
          <>
            <p className="text-sm font-semibold">{k?.title ?? `Événement ${detail.event_id ?? ""}`.trim()}</p>
            {detail.summary && detail.summary !== k?.title && <p className="mt-0.5 break-words text-[13px]">{detail.summary}</p>}
            <p className="text-[11px] text-muted">
              {channelLabel(detail.channel)} · ID <span className="font-mono">{detail.event_id ?? "—"}</span> · {fmtDateTime(detail.timestamp)}
              {detail.computer && ` · ${detail.computer}`}
            </p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {k && <Chip tone={INTEREST_TONE[k.level] ?? "muted"}>intérêt {INTEREST_LABEL[k.level] ?? k.level}</Chip>}
              {k?.attack && <Chip tone="muted">ATT&amp;CK {k.attack}</Chip>}
              {detail.alerts.length > 0 && <Chip tone="critical">{detail.alerts.length} alerte(s)</Chip>}
            </div>
            {onCreateRule && (
              <button
                onClick={() => onCreateRule(seedFromEvent(detail))}
                className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 text-xs font-medium text-accent transition hover:bg-accent/20"
              >
                <span aria-hidden="true">◆</span> Créer une règle de détection depuis cet événement
              </button>
            )}

            {k ? (
              <div className="mt-3 space-y-1.5 rounded-lg border border-line p-2.5">
                <p>{k.what}</p>
                <p className="text-muted">
                  <span className="text-foreground">Pourquoi c&apos;est important :</span> {k.why}
                </p>
              </div>
            ) : (
              <p className="mt-3 rounded-lg border border-line p-2.5 text-muted">
                Identifiant absent du catalogue DeTecTX : lisez le message et les champs ci-dessous.
              </p>
            )}

            {detail.alerts.length > 0 && (
              <div className="mt-3">
                <p className="eyebrow mb-1">Alertes levées sur cet événement</p>
                <ul className="space-y-1">
                  {detail.alerts.map((a) => (
                    <li key={a.id} className="flex items-center justify-between gap-2 rounded-md bg-surface-2 px-2 py-1">
                      <span className="min-w-0 truncate">{a.rule_title}</span>
                      <span className="flex shrink-0 items-center gap-1.5">
                        <Chip tone={SEVERITY_TONE[a.severity] ?? "muted"}>{a.severity}</Chip>
                        <span className="text-[10px] text-muted">{STATUS_LABEL[a.status] ?? a.status}</span>
                      </span>
                    </li>
                  ))}
                </ul>
                <Link href="/dashboard/alerts" className="mt-1 inline-block text-[11px] text-accent hover:underline">
                  Trier dans la page Alertes →
                </Link>
              </div>
            )}

            {fields.length > 0 && (
              <div className="mt-3">
                <p className="eyebrow mb-1">Champs</p>
                <dl className="grid grid-cols-[minmax(0,8rem)_1fr] gap-x-3 gap-y-1 rounded-lg bg-surface-2 p-2">
                  {fields.map(([name, value]) => (
                    <FieldRow key={name} name={name} value={value} />
                  ))}
                </dl>
              </div>
            )}

            {detail.message && (
              <details className="mt-3">
                <summary className="cursor-pointer text-[11px] text-muted hover:text-foreground">Message brut</summary>
                <pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-2 font-mono text-[11px]">{detail.message}</pre>
              </details>
            )}

            <button
              onClick={() => {
                // Copie de l'événement tel qu'enregistré (sans les ajouts DeTecTX : catalogue, alertes).
                const raw = {
                  timestamp: detail.timestamp,
                  channel: detail.channel,
                  event_id: detail.event_id,
                  provider: detail.provider,
                  computer: detail.computer,
                  level: detail.level,
                  record_id: detail.record_id,
                  message: detail.message,
                  fields: detail.fields,
                };
                void navigator.clipboard.writeText(JSON.stringify(raw, null, 2)).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
              className="mt-3 w-full rounded-md border border-line px-3 py-1.5 text-[11px] text-muted transition hover:border-accent/50 hover:text-accent"
            >
              {copied ? "Copié dans le presse-papiers" : "Copier l'événement (JSON)"}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function FieldRow({ name, value }: { name: string; value: unknown }) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return (
    <>
      <dt className="truncate text-muted" title={name}>
        {name}
      </dt>
      <dd className="min-w-0 break-all font-mono text-[11px]">{text}</dd>
    </>
  );
}
