"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { MitreCoverage } from "@/lib/api";
import { effectiveWith, tacticLabel, type Simulation } from "@/lib/attack";
import { ScenePoster } from "@/components/three/scene-poster";
import type { HiveHover } from "@/components/three/hive";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";

const Hive = dynamic(() => import("@/components/three/hive"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/hive_poster.png" />,
});

const hoverKey = (h: HiveHover) => h.id;

interface HivePanelProps {
  coverage: MitreCoverage;
  extra: ReadonlySet<string>;
  onToggleSource: (id: string) => void;
  sim: Simulation;
  selected: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

/** La ruche + le simulateur de couverture (« et si je collectais aussi… ? »). */
export function HivePanel({ coverage, extra, onToggleSource, sim, selected, onSelect, className = "" }: HivePanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<HiveHover>(panel, hoverKey);
  const [q, setQ] = useState("");
  const byId = useMemo(() => new Map(coverage.techniques.map((t) => [t.id, t])), [coverage.techniques]);
  const hovered = hover ? byId.get(hover.id) : undefined;

  // Recherche : identifiant ou nom ; les alvéoles non trouvées s'estompent.
  const needle = q.trim().toLowerCase();
  const matches = useMemo(
    () => (needle.length >= 2 ? coverage.techniques.filter((t) => t.id.toLowerCase().includes(needle) || (t.name ?? "").toLowerCase().includes(needle)) : null),
    [needle, coverage.techniques],
  );
  const highlight = useMemo(() => (matches ? new Set(matches.map((t) => t.id)) : null), [matches]);
  const missing = coverage.sources.filter((s) => !s.available);
  const t = coverage.totals;

  return (
    <div ref={panel} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-2">
        <span className="eyebrow">La ruche ATT&amp;CK</span>
        <span className="text-[11px] text-muted">ATT&amp;CK {coverage.attack_version} · techniques Windows</span>
        {/* Simulateur : sources non collectées aujourd'hui */}
        <div className="ml-auto flex flex-wrap items-center gap-1.5" role="group" aria-label="Simulateur de couverture">
          <span className="text-[11px] text-muted">Et si je collectais :</span>
          {missing.map((s) => {
            const on = extra.has(s.id);
            const gain = coverage.plan.find((p) => p.source === s.id);
            return (
              <button
                key={s.id}
                onClick={() => onToggleSource(s.id)}
                aria-pressed={on}
                title={s.label}
                className={`rounded-full border px-2.5 py-0.5 text-[11px] transition ${on ? "border-accent/60 bg-accent/15 text-accent" : "border-line text-muted hover:border-accent/40 hover:text-foreground"}`}
              >
                {on ? "✓ " : "+ "}
                {s.id === "Security" ? "Journal Sécurité" : s.id}
                {gain && <span className="ml-1 font-mono text-[10px] opacity-80">+{gain.techniques}</span>}
              </button>
            );
          })}
        </div>
      </div>

      <div className="relative min-h-0 flex-1">
        <Hive coverage={coverage} sources={sim.sources} selected={selected} highlight={highlight} onHover={onHover} onSelect={onSelect} />

        {/* Recherche */}
        <div className="absolute left-3 top-3 w-64">
          <input
            value={q}
            onChange={(e) => setQ(e.target.value.slice(0, 80))}
            placeholder="Chercher une technique (T1055, LSASS…)"
            aria-label="Chercher une technique"
            className="w-full rounded-lg border border-line bg-surface/90 px-2.5 py-1.5 text-xs outline-none focus:border-accent"
          />
          {matches && (
            <ul className="mt-1 max-h-48 overflow-y-auto rounded-lg border border-line bg-surface/95 text-xs shadow-lg">
              {matches.length === 0 && <li className="px-2.5 py-2 text-muted">Aucune technique.</li>}
              {matches.slice(0, 12).map((m) => (
                <li key={m.id}>
                  <button onClick={() => onSelect(m.id)} className="flex w-full gap-2 px-2.5 py-1.5 text-left hover:bg-surface-2">
                    <span className="shrink-0 font-mono text-accent">{m.id}</span>
                    <span className="truncate">{m.name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Légende + compteur simulé */}
        <div className="pointer-events-none absolute bottom-2.5 left-3 space-y-1 text-[10px] text-muted">
          <p className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-accent" /> noyau = règles actives
          </p>
          <p className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm border border-accent/60 bg-accent/15" /> verre = règles en théorie
          </p>
          <p className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-warn/60" /> angle mort (théorie seule)
          </p>
          <p className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-critical" /> observée dans des alertes
          </p>
        </div>
        <div className="pointer-events-none absolute bottom-2.5 right-3 text-right">
          <p className="font-mono text-2xl font-semibold tabular-nums leading-none">
            {sim.techniques}
            <span className="text-sm text-muted">/{t.techniques_theoretical}</span>
          </p>
          <p className="text-[11px] text-muted">
            techniques réellement couvertes
            {extra.size > 0 && <span className="text-accent"> (simulation : +{sim.techniques - t.techniques_effective})</span>}
          </p>
        </div>
      </div>

      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <p className="font-mono text-accent">{hovered.id}</p>
          <p className="font-medium">{hovered.name ?? "Technique hors référentiel"}</p>
          <p className="mt-0.5 text-muted">{hovered.tactics.map(tacticLabel).join(" · ")}</p>
          <p className="mt-1 font-mono tabular-nums">
            {effectiveWith(hovered, sim.sources)} active(s) / {hovered.theoretical} en théorie
          </p>
          {hovered.alerts > 0 && <p className="text-critical">{hovered.alerts} alerte(s) observée(s)</p>}
          <p className="mt-0.5 text-[10px] text-muted">Clic : fiche de la technique</p>
        </HoverTip>
      )}
    </div>
  );
}
