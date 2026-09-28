"use client";

import Link from "next/link";
import type { Posture } from "@/lib/api";
import { LEVEL_LABEL, LEVEL_VAR } from "@/lib/posture";
import { fmtAgo } from "@/lib/time";
import { PillarIcon } from "./pillar-icon";

/** « À faire maintenant » : les constats les plus graves, chacun avec sa source et son action. */
export function PrioritiesPanel({ posture, now, className = "" }: { posture: Posture | null; now: number; className?: string }) {
  const items = posture?.priorities ?? [];
  const strengths = (posture?.pillars ?? []).flatMap((p) => p.findings.filter((f) => f.level === "ok")).slice(0, 4);

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">À faire maintenant</span>
        {items.length > 0 && <span className="font-mono text-xs tabular-nums text-muted">{items.length} point(s)</span>}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!posture && <p className="p-4 text-sm text-muted">Évaluation de la posture…</p>}
        {posture && items.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
            <span className="flex h-11 w-11 items-center justify-center rounded-full bg-accent/15 text-accent">
              <svg viewBox="0 0 16 16" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3.5 8.4 6.6 11.4 12.5 4.8" />
              </svg>
            </span>
            <p className="text-sm font-medium">Rien ne demande votre attention.</p>
            <ul className="space-y-0.5 text-[11px] text-muted">
              {strengths.map((f) => (
                <li key={f.id}>✓ {f.title}</li>
              ))}
            </ul>
          </div>
        )}
        <ol>
          {items.map((f, i) => {
            const tone = LEVEL_VAR[f.level];
            return (
              <li key={f.id} className="group flex gap-3 border-b border-line/50 px-4 py-2.5 last:border-0">
                <span
                  className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg"
                  style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}
                  title={`Priorité ${i + 1} · ${LEVEL_LABEL[f.level]}`}
                >
                  <PillarIcon pillar={f.pillar} className="h-3.5 w-3.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={f.title}>
                    {f.title}
                  </p>
                  <p className="truncate text-[11px] text-muted" title={f.source}>
                    {f.detail ? `${f.detail} · ` : ""}
                    {f.at ? `${fmtAgo(f.at, now)} · ` : ""}
                    source : {f.source}
                  </p>
                </div>
                {f.href && f.action && (
                  <Link href={f.href} className="shrink-0 self-center rounded-lg border border-line px-2.5 py-1 text-[11px] transition hover:border-accent/60 hover:text-accent">
                    {f.action} →
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
