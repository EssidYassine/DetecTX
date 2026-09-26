"use client";

import Link from "next/link";
import type { Alert } from "@/lib/api";
import { fmtAgo } from "@/lib/time";

const DOT: Record<Alert["severity"], string> = {
  critical: "var(--critical)",
  high: "var(--warn)",
  medium: "var(--accent)",
  low: "var(--muted)",
};

interface DetectionsFeedProps {
  alerts: Alert[]; // du plus récent au plus ancien
  now: number;
  highlightId: number | null;
  onHighlight: (id: number | null) => void;
  onSelect: (alert: Alert) => void;
  className?: string;
}

/**
 * Flux de détections en direct, relié au réacteur 3D : survoler une ligne allume la sphère
 * de l'alerte ; cliquer ouvre son détail (explication IA). Pas de défilement : on affiche
 * ce qui tient, le reste est à un clic (« Tout voir »).
 */
export function DetectionsFeed({ alerts, now, highlightId, onHighlight, onSelect, className = "" }: DetectionsFeedProps) {
  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Détections</span>
        <Link href="/dashboard/alerts" className="text-xs text-accent hover:underline">
          Tout voir →
        </Link>
      </div>

      {alerts.length === 0 ? (
        <p className="p-4 text-sm text-muted">Aucune détection. Lancez la détection depuis l’onglet Alertes.</p>
      ) : (
        <ul className="min-h-0 flex-1 overflow-hidden" onMouseLeave={() => onHighlight(null)}>
          {alerts.slice(0, 14).map((a) => (
            <li key={a.id}>
              <button
                onClick={() => onSelect(a)}
                onMouseEnter={() => onHighlight(a.id)}
                onFocus={() => onHighlight(a.id)}
                onBlur={() => onHighlight(null)}
                className={`flex w-full items-center gap-2.5 border-b border-line/50 px-4 py-2 text-left transition ${
                  highlightId === a.id ? "bg-surface-2" : "hover:bg-surface-2"
                }`}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: DOT[a.severity], boxShadow: highlightId === a.id ? `0 0 8px ${DOT[a.severity]}` : undefined }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{a.rule_title}</span>
                {a.mitre && <span className="hidden shrink-0 font-mono text-[11px] text-accent xl:inline">{a.mitre}</span>}
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted">{fmtAgo(a.created_at, now)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
