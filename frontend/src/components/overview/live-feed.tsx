"use client";

import Link from "next/link";
import type { AlertCase, FeedItem } from "@/lib/api";
import { isOpen, SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/cases";
import { INTEREST_TONE, THEMES } from "@/lib/events-ui";
import { fmtAgo } from "@/lib/time";
import { ThemeIcon } from "@/components/events/theme-icon";

type Entry =
  | { kind: "case"; at: string; key: string; c: AlertCase }
  | { kind: "event"; at: string; key: string; e: FeedItem };

const MAX = 30;

/**
 * « Ce qui se passe » : un seul fil pour les détections (dossiers d'alertes) et les faits
 * marquants de la machine (Wi-Fi, pare-feu, périphériques, sessions…), du plus récent au plus ancien.
 */
export function LiveFeed({ cases, feed, now, className = "" }: { cases: AlertCase[] | null; feed: FeedItem[] | null; now: number; className?: string }) {
  const entries: Entry[] = [
    ...(cases ?? []).map((c) => ({ kind: "case" as const, at: c.last_seen, key: `c:${c.rule_id}`, c })),
    ...(feed ?? []).map((e) => ({ kind: "event" as const, at: e.timestamp, key: `e:${e.id}`, e })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, MAX);
  const loading = cases === null && feed === null;

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="flex items-center gap-2">
          <span className="relative flex h-1.5 w-1.5">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
          </span>
          <span className="eyebrow">Ce qui se passe</span>
        </span>
        <span className="flex gap-3 text-xs">
          <Link href="/dashboard/alerts" className="text-accent hover:underline">
            Alertes →
          </Link>
          <Link href="/dashboard/events" className="text-accent hover:underline">
            Journaux →
          </Link>
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1.5">
        {loading && <p className="p-3 text-sm text-muted">Chargement du fil…</p>}
        {!loading && entries.length === 0 && <p className="p-3 text-sm text-muted">Rien de marquant ces dernières 24 h.</p>}
        <ol className="space-y-0.5">
          {entries.map((it) =>
            it.kind === "case" ? (
              <li key={it.key}>
                <Link href={`/dashboard/alerts?case=${encodeURIComponent(it.c.rule_id)}`} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-surface-2">
                  <CaseGlyph c={it.c} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-xs font-medium">
                      {it.c.rule_title}
                      {it.c.count > 1 && <span className="ml-1 font-mono text-muted">×{it.c.count}</span>}
                    </span>
                    <span className="block text-[10px] text-muted">
                      Détection {SEVERITY_LABEL[it.c.severity].toLowerCase()} · {isOpen(it.c) ? "à traiter" : "close"} · {fmtAgo(it.at, now)}
                    </span>
                  </span>
                </Link>
              </li>
            ) : (
              <li key={it.key}>
                <Link href={`/dashboard/events?event=${encodeURIComponent(it.e.id)}`} className="flex items-start gap-2.5 rounded-lg px-2 py-1.5 transition hover:bg-surface-2">
                  <EventGlyph e={it.e} />
                  <span className="min-w-0 flex-1">
                    <span className="line-clamp-1 text-xs">{it.e.summary ?? it.e.title ?? `Événement ${it.e.event_id ?? ""}`}</span>
                    <span className="block text-[10px] text-muted">
                      {(THEMES[it.e.theme] ?? THEMES.apps).label} · {fmtAgo(it.at, now)}
                      {it.e.count > 1 && <span className="ml-1 font-mono">×{it.e.count}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ),
          )}
        </ol>
      </div>
    </div>
  );
}

function CaseGlyph({ c }: { c: AlertCase }) {
  const tone = isOpen(c) ? SEVERITY_TONE[c.severity] : "muted";
  return (
    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg" style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}>
      <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinejoin="round" aria-hidden="true">
        <path d="M8 1.8 14 13H2L8 1.8ZM8 6v3.4M8 11.2h.01" strokeLinecap="round" />
      </svg>
    </span>
  );
}

function EventGlyph({ e }: { e: FeedItem }) {
  const tone = INTEREST_TONE[e.level] ?? "muted";
  return (
    <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-lg" style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 12%, transparent)` }}>
      <ThemeIcon icon={(THEMES[e.theme] ?? THEMES.apps).icon} className="h-3.5 w-3.5" />
    </span>
  );
}
