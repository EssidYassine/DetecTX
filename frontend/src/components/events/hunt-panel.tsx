"use client";

import { useEffect, useState } from "react";
import { searchEvents, type CollectionHealth, type EventPage, type Hunt } from "@/lib/api";
import { channelLabel, fmtDateTime, LIST_WINDOWS, SOURCES, THEMES, type ListWindow } from "@/lib/events-ui";
import { LevelBadge } from "@/components/ui";
import { ThemeIcon } from "./theme-icon";
import { seedFromSearch, type RuleSeed } from "@/lib/rule-seed";

export const PAGE_SIZE = 30;

export interface EventQuery {
  hunt: string | null;
  channel: string; // "" = tous
  theme: string | null; // thème choisi dans le relief (remplace le journal)
  eventId: number | null;
  q: string;
  window: ListWindow;
  slice: { since: string; until: string; label: string } | null; // tranche choisie dans le relief
  page: number;
}

const LEVEL_TONE: Record<string, string> = { high: "critical", medium: "warn", low: "accent", info: "muted" };

interface HuntPanelProps {
  query: EventQuery;
  onQuery: (patch: Partial<EventQuery>) => void;
  hunts: Hunt[] | null;
  health: CollectionHealth | null;
  selected: string | null;
  onOpen: (id: string) => void;
  refreshKey: number;
  /** Transforme la recherche courante (journal, ID, texte) en règle de détection. */
  onCreateRule?: (seed: RuleSeed) => void;
  className?: string;
}

/** Liste des événements + chasses prêtes à l'emploi. Seule la liste défile. */
export function HuntPanel({ query, onQuery, hunts, health, selected, onOpen, refreshKey, onCreateRule, className = "" }: HuntPanelProps) {
  const [text, setText] = useState(query.q);
  const [idText, setIdText] = useState(query.eventId === null ? "" : String(query.eventId));
  const key = JSON.stringify({ query, refreshKey });
  const [result, setResult] = useState<{ key: string; page: EventPage | null; error: string | null } | null>(null);
  const loading = result?.key !== key;

  // Recherche plein texte : on attend que la saisie se calme (300 ms).
  useEffect(() => {
    if (text === query.q) return;
    const id = window.setTimeout(() => onQuery({ q: text.trim() }), 300);
    return () => window.clearTimeout(id);
  }, [text, query.q, onQuery]);

  useEffect(() => {
    let cancelled = false;
    const minutes = query.slice ? undefined : LIST_WINDOWS.find((w) => w.key === query.window)?.minutes;
    searchEvents({
      offset: query.page * PAGE_SIZE,
      limit: PAGE_SIZE,
      q: query.q || undefined,
      hunt: query.hunt ?? undefined,
      channel: query.hunt || query.theme ? undefined : query.channel || undefined,
      theme: query.hunt ? undefined : (query.theme ?? undefined),
      eventId: query.hunt ? undefined : (query.eventId ?? undefined),
      minutes,
      since: query.slice?.since,
      until: query.slice?.until,
    })
      .then((page) => !cancelled && setResult({ key, page, error: null }))
      .catch((e) => !cancelled && setResult({ key, page: null, error: e instanceof Error ? e.message : "Recherche impossible" }));
    return () => {
      cancelled = true;
    };
  }, [key, query]);

  const page = result?.page ?? null;
  const filtered = query.hunt !== null || query.theme !== null || query.channel !== "" || query.eventId !== null || query.q !== "" || query.slice !== null;
  const total = page?.total ?? 0;
  const first = total === 0 ? 0 : query.page * PAGE_SIZE + 1;
  const last = Math.min(total, (query.page + 1) * PAGE_SIZE);
  const unmet = (h: Hunt) =>
    h.requires.includes("sysmon") && health && !health.sysmon.running
      ? "Nécessite Sysmon"
      : h.requires.includes("admin") && health && !health.collectors.some((c) => c.alive && c.admin)
        ? "Nécessite l'agent en administrateur (journal Sécurité)"
        : null;
  const applyId = () => {
    const n = idText.trim() === "" ? null : Number(idText);
    if (n === null || (Number.isInteger(n) && n >= 0)) onQuery({ eventId: n, hunt: null });
  };

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Chasse aux événements</span>
        <span className="text-xs text-muted">{loading ? "recherche…" : `${first}–${last} sur ${total.toLocaleString("fr-FR")}`}</span>
      </div>

      {/* Chasses prêtes à l'emploi */}
      <div className="flex gap-1.5 overflow-x-auto border-b border-line px-3 py-2" role="group" aria-label="Chasses prêtes à l'emploi">
        {(hunts ?? []).map((h) => {
          const active = query.hunt === h.id;
          const blocked = unmet(h);
          const tone = h.count > 0 ? LEVEL_TONE[h.level] ?? "accent" : "muted";
          return (
            <button
              key={h.id}
              onClick={() => onQuery({ hunt: active ? null : h.id, channel: "", theme: null, eventId: null, slice: null })}
              aria-pressed={active}
              title={`${h.question}${h.attack ? ` · ATT&CK ${h.attack}` : ""}${blocked ? ` · ${blocked}` : ""}`}
              className={`flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] transition ${
                active ? "border-accent/60 bg-accent/15 text-accent" : "border-line hover:border-accent/40"
              } ${blocked && !active ? "opacity-55" : ""}`}
            >
              {h.title}
              <span
                className="rounded-full px-1.5 font-mono text-[10px] tabular-nums"
                style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}
              >
                {h.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Filtres */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <select
          value={query.hunt || query.theme ? "" : query.channel}
          onChange={(e) => onQuery({ channel: e.target.value, hunt: null, theme: null })}
          disabled={query.hunt !== null}
          aria-label="Journal"
          className="rounded-md border border-line bg-surface-2 px-2 py-1 outline-none focus:border-accent disabled:opacity-50"
        >
          <option value="">Tous les journaux</option>
          {SOURCES.map((s) => (
            <option key={s.channel} value={s.channel}>
              {s.label}
            </option>
          ))}
        </select>
        <input
          value={idText}
          onChange={(e) => setIdText(e.target.value.replace(/[^0-9]/g, "").slice(0, 6))}
          onBlur={applyId}
          onKeyDown={(e) => e.key === "Enter" && applyId()}
          disabled={query.hunt !== null}
          placeholder="Event ID"
          aria-label="Identifiant d'événement"
          inputMode="numeric"
          className="w-20 rounded-md border border-line bg-surface-2 px-2 py-1 font-mono outline-none focus:border-accent disabled:opacity-50"
        />
        <input
          value={text}
          onChange={(e) => setText(e.target.value.slice(0, 200))}
          placeholder="Rechercher dans le message…"
          aria-label="Recherche dans le message"
          className="min-w-40 flex-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 outline-none focus:border-accent"
        />
        {query.theme && THEMES[query.theme] && (
          <span className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-accent">
            <ThemeIcon icon={THEMES[query.theme].icon} className="h-3.5 w-3.5" />
            {THEMES[query.theme].label}
            <button onClick={() => onQuery({ theme: null })} className="text-muted hover:text-foreground" aria-label="Retirer le thème">
              ✕
            </button>
          </span>
        )}
        {onCreateRule && !query.hunt && !query.theme && (query.channel || query.eventId !== null || query.q) && (
          <button
            onClick={() => onCreateRule(seedFromSearch({ channel: query.channel, eventId: query.eventId, q: query.q }))}
            title="Créer une règle qui alertera sur ce que cette recherche trouve"
            className="rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-accent transition hover:bg-accent/20"
          >
            ◆ En faire une règle
          </button>
        )}
        {query.slice ? (
          <span className="flex items-center gap-1.5 rounded-md border border-accent/40 bg-accent/10 px-2 py-1 text-accent">
            {query.slice.label}
            <button onClick={() => onQuery({ slice: null })} className="text-muted hover:text-foreground" aria-label="Retirer la tranche horaire">
              ✕
            </button>
          </span>
        ) : (
          <select
            value={query.window}
            onChange={(e) => onQuery({ window: e.target.value as ListWindow })}
            aria-label="Période"
            className="rounded-md border border-line bg-surface-2 px-2 py-1 outline-none focus:border-accent"
          >
            {LIST_WINDOWS.map((w) => (
              <option key={w.key} value={w.key}>
                {w.label}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* Liste : la seule zone qui défile */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {result?.error && result.key === key && <p className="px-4 py-6 text-center text-xs text-critical">{result.error}</p>}
        {!loading && page && page.items.length === 0 && (
          <p className="px-4 py-8 text-center text-xs text-muted">
            {filtered
              ? `Aucun événement ne correspond sur ${query.slice ? "cette tranche horaire" : `la période « ${LIST_WINDOWS.find((w) => w.key === query.window)?.label} »`}${query.window !== "all" && !query.slice ? " : élargissez à « Tout »" : ""}.`
              : health?.status === "down"
                ? "Aucun événement : la collecte est arrêtée (voir « Santé de la collecte »)."
                : "Aucun événement sur cette période."}
          </p>
        )}
        <table className="w-full table-fixed text-left text-xs">
          <thead className="sticky top-0 z-10 bg-surface text-[10px] uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="w-[8.75rem] px-4 py-1.5 font-medium">Date</th>
              <th className="w-[5.5rem] px-2 py-1.5 font-medium">Journal</th>
              <th className="px-2 py-1.5 font-medium">Événement</th>
              <th className="w-[6.5rem] px-4 py-1.5 text-right font-medium">Niveau</th>
            </tr>
          </thead>
          <tbody className={loading ? "opacity-60" : ""}>
            {(page?.items ?? []).map((e) => (
              <tr
                key={e.id}
                onClick={() => onOpen(e.id)}
                aria-selected={e.id === selected}
                className={`cursor-pointer border-b border-line/40 transition-colors ${e.id === selected ? "bg-accent/10" : "hover:bg-surface-2"}`}
              >
                <td className="whitespace-nowrap px-4 py-1.5 font-mono text-[11px] tabular-nums text-muted">{fmtDateTime(e.timestamp)}</td>
                <td className="truncate px-2 py-1.5">{channelLabel(e.channel)}</td>
                <td className="px-2 py-1.5">
                  <span className="block truncate">
                    <span className="font-mono text-muted">{e.event_id ?? "—"}</span>
                    {e.summary || e.title ? (
                      <span className="ml-1.5 font-medium" title={e.title ?? undefined}>
                        {e.summary ?? e.title}
                      </span>
                    ) : (
                      <span className="ml-1.5 text-muted">{e.message?.slice(0, 160)}</span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-1.5 text-right">
                  <LevelBadge level={e.level} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between border-t border-line px-4 py-1.5 text-xs">
        <button
          onClick={() => onQuery({ page: Math.max(0, query.page - 1) })}
          disabled={query.page === 0}
          className="rounded-md px-2 py-0.5 text-muted transition hover:text-foreground disabled:opacity-30"
        >
          ← Précédents
        </button>
        <span className="text-muted">page {query.page + 1}</span>
        <button
          onClick={() => onQuery({ page: query.page + 1 })}
          disabled={last >= total}
          className="rounded-md px-2 py-0.5 text-muted transition hover:text-foreground disabled:opacity-30"
        >
          Suivants →
        </button>
      </div>
    </div>
  );
}
