"use client";

import { useState } from "react";
import type { CollectionHealth, FeedItem } from "@/lib/api";
import { INTEREST_TONE, THEMES } from "@/lib/events-ui";
import { fmtAgo } from "@/lib/time";
import { HEALTH_LABEL, HEALTH_TONE, HealthView } from "./health-panel";
import { ThemeIcon } from "./theme-icon";

type Tab = "feed" | "health";

interface SidePanelProps {
  feed: FeedItem[] | null;
  health: CollectionHealth | null;
  email: string | null;
  now: number;
  selected: string | null;
  onOpen: (id: string) => void;
  className?: string;
}

/**
 * Colonne de droite : « ce qui se passe » (fil de la machine, en phrases) et la santé de la
 * collecte. Si la collecte est arrêtée, la santé s'ouvre d'office : le fil vide ne voudrait rien dire.
 */
export function SidePanel({ feed, health, email, now, selected, onOpen, className = "" }: SidePanelProps) {
  const [chosen, setChosen] = useState<Tab | null>(null);
  const tab: Tab = chosen ?? (health?.status === "down" ? "health" : "feed");
  const tone = health ? HEALTH_TONE[health.status] : "muted";

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Activité et collecte">
        {(
          [
            ["feed", "Fil de la machine"],
            ["health", "Santé de la collecte"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            onClick={() => setChosen(key)}
            title={key === "health" && health ? HEALTH_LABEL[health.status] : undefined}
            className={`flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs transition ${tab === key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
          >
            {key === "feed" ? (
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
              </span>
            ) : (
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(--${tone})` }} aria-hidden="true" />
            )}
            {label}
            {key === "health" && health && <span className="sr-only"> : {HEALTH_LABEL[health.status]}</span>}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {tab === "health" ? (
          <div className="px-2 py-1">
            <HealthView health={health} email={email} now={now} />
          </div>
        ) : (
          <FeedList feed={feed} now={now} selected={selected} onOpen={onOpen} />
        )}
      </div>
    </div>
  );
}

function FeedList({ feed, now, selected, onOpen }: { feed: FeedItem[] | null; now: number; selected: string | null; onOpen: (id: string) => void }) {
  if (feed === null) return <p className="px-2 py-6 text-center text-xs text-muted">Chargement du fil…</p>;
  if (feed.length === 0) return <p className="px-2 py-6 text-center text-xs text-muted">Rien de marquant ces dernières 24 h.</p>;
  return (
    <ol className="space-y-0.5" aria-label="Événements marquants récents">
      {feed.map((item) => {
        const theme = THEMES[item.theme] ?? THEMES.apps;
        const tone = INTEREST_TONE[item.level] ?? "muted";
        const active = item.id === selected;
        return (
          <li key={item.id}>
            <button
              onClick={() => onOpen(item.id)}
              aria-current={active}
              className={`flex w-full items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition ${active ? "bg-accent/10" : "hover:bg-surface-2"}`}
            >
              <span
                className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg"
                style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 13%, transparent)` }}
              >
                <ThemeIcon icon={theme.icon} className="h-3.5 w-3.5" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="line-clamp-2 text-xs">{item.summary ?? item.title ?? `Événement ${item.event_id ?? ""}`}</span>
                <span className="mt-0.5 block text-[10px] text-muted">
                  {theme.label} · {fmtAgo(item.timestamp, now)}
                  {item.count > 1 && <span className="ml-1.5 rounded bg-surface-2 px-1 font-mono text-foreground">×{item.count}</span>}
                </span>
              </span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}
