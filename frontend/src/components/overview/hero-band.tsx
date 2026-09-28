"use client";

import Link from "next/link";
import type { Posture, PostureTone } from "@/lib/api";
import { greeting, PILLAR_ORDER, TONE_VAR } from "@/lib/posture";
import { ReportButton } from "@/components/report-button";
import { PillarIcon } from "./pillar-icon";

// Verdict dans la phrase « votre poste … est … ».
const PHRASE: Record<PostureTone, string> = { ok: "sous contrôle", warn: "à surveiller", critical: "à sécuriser maintenant", unknown: "en cours d'évaluation" };

interface HeroBandProps {
  posture: Posture | null;
  hostname: string | null;
  now: number;
}

/**
 * Bandeau d'accueil : une phrase humaine qui dit où en est le poste, puis les 5 piliers.
 * Lueur chaude à gauche (la page accueille avant d'alerter) ; la couleur du verdict reste
 * celle de la sévérité réelle.
 */
export function HeroBand({ posture, hostname, now }: HeroBandProps) {
  const date = new Date(now);
  const tone = posture ? TONE_VAR[posture.tone] : "muted";
  const byKey = new Map((posture?.pillars ?? []).map((p) => [p.key, p]));

  return (
    <section
      className="relative flex flex-wrap items-center gap-x-6 gap-y-3 overflow-hidden rounded-2xl border border-line px-5 py-3.5 lg:flex-nowrap"
      style={{
        background: `radial-gradient(120% 180% at 0% 0%, color-mix(in srgb, #fbbf77 13%, transparent) 0%, transparent 45%), radial-gradient(90% 160% at 100% 100%, color-mix(in srgb, var(--${tone}) 9%, transparent) 0%, transparent 55%), var(--surface)`,
      }}
    >
      <span className="absolute inset-y-3 left-0 w-1 rounded-r-full" style={{ backgroundColor: `var(--${tone})` }} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        {/* Date et salutation seulement côté navigateur (données chargées) : la page est pré-rendue
            au build, un texte horaire rendu côté serveur différerait (erreur d'hydratation). */}
        <p className="h-4 text-xs text-muted">
          {posture && (
            <>
              {date.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long" })} ·{" "}
              <span className="font-mono tabular-nums">{date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}</span>
            </>
          )}
        </p>
        <h1 className="mt-0.5 truncate font-display text-lg font-semibold tracking-wide 2xl:text-xl">
          {posture ? (
            <>
              {greeting(date)}
              <span className="text-muted"> — </span>
              votre poste {hostname && <span className="text-foreground">{hostname}</span>} est{" "}
              <span style={{ color: `var(--${tone})` }}>{PHRASE[posture.tone]}</span>
            </>
          ) : (
            <span className="text-muted">lecture de la posture…</span>
          )}
        </h1>
        <p className="mt-0.5 line-clamp-2 text-sm text-muted" title={posture?.summary}>
          {posture?.summary ?? "DeTecTX rassemble menaces, exposition réseau, défenses, collecte et ressources."}
        </p>
      </div>

      <nav className="flex shrink-0 flex-wrap gap-1.5" aria-label="Piliers de la posture">
        {PILLAR_ORDER.map((key) => {
          const p = byKey.get(key);
          const t = p ? TONE_VAR[p.tone] : "muted";
          return (
            <Link
              key={key}
              href={p?.href ?? "#"}
              title={p ? `${p.label} : ${p.headline}` : undefined}
              className="group flex items-center gap-2 rounded-xl border border-line bg-surface/70 px-2.5 py-1.5 backdrop-blur transition hover:-translate-y-0.5 hover:border-current"
              style={{ color: `var(--${t})` }}
            >
              <PillarIcon pillar={key} className="h-4 w-4 shrink-0" />
              <span className="leading-tight">
                <span className="block text-[10px] text-muted group-hover:text-foreground">{p?.label ?? "…"}</span>
                <span className="font-mono text-sm font-semibold tabular-nums">{p?.score ?? "—"}</span>
              </span>
            </Link>
          );
        })}
      </nav>
      <div className="shrink-0">
        <ReportButton />
      </div>
    </section>
  );
}
