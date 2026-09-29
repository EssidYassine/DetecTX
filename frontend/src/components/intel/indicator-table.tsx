"use client";

import { useMemo, useState } from "react";
import type { IntelIndicator } from "@/lib/api";
import { SIGHTING_LABEL, TYPE_LABEL, VERDICT_LABEL, VERDICT_TONE } from "@/lib/intel";

type Filter = "all" | "matches" | "ip" | "domain" | "hash";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "matches", label: "Reconnus" },
  { key: "ip", label: "IP contactées" },
  { key: "domain", label: "Domaines" },
  { key: "hash", label: "Programmes" },
];

interface IndicatorTableProps {
  indicators: IntelIndicator[];
  selected: string | null;
  onSelect: (value: string) => void;
  className?: string;
}

/** Inventaire des indicateurs DE CE POSTE (et seulement de lui), les reconnus en premier. */
export function IndicatorTable({ indicators, selected, onSelect, className = "" }: IndicatorTableProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const counts: Record<Filter, number> = {
    all: indicators.length,
    matches: indicators.filter((i) => i.verdict !== "unknown").length,
    ip: indicators.filter((i) => i.type === "ip").length,
    domain: indicators.filter((i) => i.type === "domain").length,
    hash: indicators.filter((i) => i.type === "hash").length,
  };
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return indicators.filter(
      (i) =>
        (filter === "all" || (filter === "matches" ? i.verdict !== "unknown" : i.type === filter)) &&
        (!needle || i.value.toLowerCase().includes(needle) || i.seen.label.toLowerCase().includes(needle) || (i.seen.process ?? "").toLowerCase().includes(needle)),
    );
  }, [indicators, filter, q]);

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition ${filter === f.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
          >
            {f.label}
            <span className={`font-mono text-[10px] ${f.key === "matches" && counts.matches ? "text-critical" : ""}`}>{counts[f.key]}</span>
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, 100))}
          placeholder="Filtrer (valeur, processus…)"
          aria-label="Filtrer les indicateurs"
          className="ml-auto w-44 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-xs outline-none focus:border-accent"
        />
      </div>

      {counts.matches === 0 && indicators.length > 0 && (
        <p className="flex items-center gap-2 border-b border-line bg-accent/5 px-4 py-2 text-xs text-accent">
          <span aria-hidden="true">✓</span> Aucun indicateur de ce poste n&apos;apparaît dans les listes publiques de menaces.
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {shown.length === 0 && <p className="p-6 text-center text-sm text-muted">Aucun indicateur pour ce filtre.</p>}
        <ul>
          {shown.map((i) => {
            const tone = VERDICT_TONE[i.verdict];
            const active = i.value === selected;
            return (
              <li key={i.value}>
                <button onClick={() => onSelect(i.value)} aria-current={active} className={`flex w-full items-start gap-3 border-b border-line/50 px-3 py-2 text-left transition ${active ? "bg-accent/10" : "hover:bg-surface-2/70"}`}>
                  <span className="mt-0.5 w-16 shrink-0 rounded px-1.5 py-px text-center text-[10px] font-medium" style={{ color: `var(--${tone === "muted" ? "foreground" : tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}>
                    {TYPE_LABEL[i.type]}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-mono text-xs" title={i.value}>
                      {i.value}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {SIGHTING_LABEL[i.seen.kind]} · {i.seen.label}
                      {i.sightings > 1 && ` · +${i.sightings - 1}`}
                    </span>
                  </span>
                  <span className="shrink-0 text-right text-[11px]" style={{ color: `var(--${tone})` }}>
                    {VERDICT_LABEL[i.verdict]}
                    {i.feeds.length > 0 && <span className="block text-[10px]">{i.feeds.join(", ")}</span>}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
