"use client";

import { useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { IntelOverview } from "@/lib/api";
import { fmtDate, SIGHTING_LABEL, TYPE_LABEL, VERDICT_LABEL, VERDICT_TONE } from "@/lib/intel";
import { ScenePoster } from "@/components/three/scene-poster";
import type { SieveHover } from "@/components/three/sieve";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";

const Sieve = dynamic(() => import("@/components/three/sieve"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/sieve_poster.png" />,
});

const hoverKey = (h: SieveHover) => h.value;

interface SievePanelProps {
  overview: IntelOverview;
  selected: string | null;
  onSelect: (value: string) => void;
  isAdmin: boolean;
  busy: boolean;
  onRefreshFeeds: () => void;
  onToggleFeed: (id: string, enabled: boolean) => void;
  className?: string;
}

/** Le tamis (vue) et les sources de renseignement (réglages). */
export function SievePanel({ overview, selected, onSelect, isAdmin, busy, onRefreshFeeds, onToggleFeed, className = "" }: SievePanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<SieveHover>(panel, hoverKey);
  const [tab, setTab] = useState<"sieve" | "sources">("sieve");
  const hovered = hover ? overview.indicators.find((i) => i.value === hover.value) : undefined;

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Tamis et sources">
        {(
          [
            ["sieve", "Le tamis"],
            ["sources", "Sources"],
          ] as const
        ).map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className={`rounded-lg px-2.5 py-1 text-xs transition ${tab === key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}>
            {label}
          </button>
        ))}
        <span className="ml-auto text-[10px] text-muted">rien de votre poste n&apos;est envoyé</span>
      </div>

      {tab === "sieve" ? (
        <div className="relative min-h-0 flex-1">
          <Sieve overview={overview} selected={selected} onHover={onHover} onSelect={onSelect} />
          <p className="pointer-events-none absolute left-3 top-2.5 max-w-[12rem] text-[10px] leading-snug text-muted">
            Chaque grain est un indicateur de ce poste, passé au crible des sources. Un grain qui s&apos;arrête et rougit est reconnu malveillant.
          </p>
        </div>
      ) : (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-xs">
          <section>
            <div className="mb-1.5 flex items-center justify-between">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">Listes publiques (comparées en local)</p>
              {isAdmin && (
                <button onClick={onRefreshFeeds} disabled={busy} className="text-[11px] text-accent hover:underline disabled:opacity-50">
                  {busy ? "Mise à jour…" : "Mettre à jour"}
                </button>
              )}
            </div>
            <ul className="space-y-1.5">
              {overview.feeds.map((f) => (
                <li key={f.id} className="rounded-lg border border-line px-2.5 py-2">
                  <div className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: `var(--${!f.enabled ? "muted" : f.error ? "warn" : "accent"})` }} />
                    <a href={f.homepage} target="_blank" rel="noreferrer noopener" className="font-medium hover:text-accent">
                      {f.name}
                    </a>
                    <span className="ml-auto font-mono text-[10px] text-muted">{f.count?.toLocaleString("fr-FR") ?? "—"}</span>
                    {isAdmin && (
                      <button onClick={() => onToggleFeed(f.id, !f.enabled)} aria-pressed={f.enabled} className={`rounded px-1.5 text-[10px] ${f.enabled ? "bg-accent/15 text-accent" : "bg-surface-2 text-muted"}`}>
                        {f.enabled ? "active" : "inactive"}
                      </button>
                    )}
                  </div>
                  <p className="mt-0.5 text-[11px] text-muted">{f.description}</p>
                  <p className="text-[10px] text-muted">
                    {f.license} · mise à jour {fmtDate(f.updated)}
                    {f.error && <span className="text-warn"> · {f.error}</span>}
                  </p>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted">Analyses en ligne (à la demande)</p>
            <ul className="space-y-1">
              {overview.providers.map((p) => (
                <li key={p.id} className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-1.5">
                  <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: `var(--${p.configured ? "accent" : "muted"})` }} />
                  <span className="font-medium">{p.name}</span>
                  <span className="ml-auto text-[10px] text-muted">{p.configured ? "clé configurée" : <code className="font-mono">{p.env}</code>}</span>
                </li>
              ))}
            </ul>
            <p className="mt-1.5 text-[10px] leading-relaxed text-muted">
              Les clés se renseignent dans le fichier <code className="font-mono">.env</code> du serveur, jamais dans l&apos;interface. Seuls des indicateurs publics de ce poste sont envoyés, sur demande.
            </p>
          </section>
        </div>
      )}

      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-mono text-[11px] break-all">{hovered.value}</p>
          <p className="mt-0.5" style={{ color: `var(--${VERDICT_TONE[hovered.verdict]})` }}>
            {TYPE_LABEL[hovered.type]} · {VERDICT_LABEL[hovered.verdict]}
          </p>
          <p className="mt-0.5 text-muted">
            {SIGHTING_LABEL[hovered.seen.kind]} : {hovered.seen.label}
          </p>
          <p className="mt-0.5 text-[10px] text-muted">Clic : fiche de l&apos;indicateur</p>
        </HoverTip>
      )}
    </div>
  );
}
