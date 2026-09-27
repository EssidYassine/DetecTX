"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { CATEGORY_LABEL, matchApp, sortApps, type AppCategory, type AppGroup, type AppSort } from "@/lib/apps";
import { fmtBytes, loadTone, machineLoad } from "@/lib/host";
import { Avatar } from "./process-details";

interface AppsPanelProps {
  apps: AppGroup[];
  cpuCount: number;
  current: string | null; // clé de l'application affichée
  onPick: (app: AppGroup) => void;
  className?: string;
}

const SORTS: { key: AppSort; label: string }[] = [
  { key: "memory", label: "Mémoire" },
  { key: "cpu", label: "CPU" },
  { key: "name", label: "Nom" },
];
const ORDER: AppCategory[] = ["window", "background", "system"];

/** Les processus regroupés par application : ~80 lignes lisibles au lieu de 300 processus. */
export function AppsPanel({ apps, cpuCount, current, onPick, className = "" }: AppsPanelProps) {
  const [sort, setSort] = useState<AppSort>("memory");
  const [query, setQuery] = useState("");
  const [onlyHints, setOnlyHints] = useState(false);
  const [folded, setFolded] = useState<Set<AppCategory>>(() => new Set(["system"]));
  const list = useRef<HTMLDivElement>(null);

  const flagged = apps.filter((a) => a.hints > 0).length;
  const sections = useMemo(() => {
    const visible = sortApps(apps, sort).filter((a) => matchApp(a, query) && (!onlyHints || a.hints > 0));
    return ORDER.map((cat) => ({ cat, apps: visible.filter((a) => a.category === cat) })).filter((s) => s.apps.length > 0);
  }, [apps, sort, query, onlyHints]);

  useEffect(() => {
    if (current) list.current?.querySelector<HTMLElement>(`[data-app="${CSS.escape(current)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  const toggle = (cat: AppCategory) =>
    setFolded((f) => {
      const next = new Set(f);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Applications</span>
        <span className="text-xs text-muted">
          {apps.length} applications · {apps.reduce((s, a) => s + a.members.length, 0)} processus
        </span>
      </div>

      <div className="space-y-2 border-b border-line px-4 py-2.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Rechercher : nom, PID, chemin…"
          aria-label="Rechercher une application"
          className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs outline-none transition focus:border-accent"
        />
        <div className="flex items-center gap-1">
          {SORTS.map((s) => (
            <button
              key={s.key}
              onClick={() => setSort(s.key)}
              aria-pressed={sort === s.key}
              className={`rounded-md px-2 py-0.5 text-[11px] transition ${sort === s.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
            >
              {s.label}
            </button>
          ))}
          <button
            onClick={() => setOnlyHints((v) => !v)}
            disabled={flagged === 0}
            aria-pressed={onlyHints}
            title="Afficher seulement les applications avec un indice d'analyse"
            className={`ml-auto rounded-md px-2 py-0.5 text-[11px] transition disabled:opacity-40 ${onlyHints ? "bg-warn/15 text-warn" : "text-muted hover:text-foreground"}`}
          >
            ⚑ {flagged} indice{flagged > 1 ? "s" : ""}
          </button>
        </div>
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto pb-2">
        {sections.length === 0 && <p className="px-4 py-8 text-center text-xs text-muted">{apps.length ? "Aucune application ne correspond." : "Chargement…"}</p>}
        {sections.map(({ cat, apps: rows }) => {
          const open = !folded.has(cat) || query !== "" || onlyHints;
          return (
            <section key={cat}>
              <button
                onClick={() => toggle(cat)}
                aria-expanded={open}
                className="sticky top-0 z-10 flex w-full items-center gap-2 bg-surface px-4 pb-1.5 pt-3 text-left"
              >
                <span className="w-3 text-[10px] text-muted">{open ? "▾" : "▸"}</span>
                <span className="eyebrow">{CATEGORY_LABEL[cat]}</span>
                <span className="ml-auto font-mono text-[10px] text-muted">{rows.length}</span>
              </button>
              {open &&
                rows.map((app) => {
                  const load = machineLoad(app.cpu, cpuCount);
                  const active = app.key === current;
                  return (
                    <button
                      key={app.key}
                      data-app={app.key}
                      onClick={() => onPick(app)}
                      aria-current={active}
                      className={`relative flex w-full items-center gap-3 px-4 py-1.5 text-left transition-colors ${active ? "bg-accent/10" : "hover:bg-surface-2"}`}
                    >
                      {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" />}
                      <Avatar name={app.name} tone={app.hints > 0 ? "warn" : cat === "system" ? "muted" : "accent"} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{app.name}</span>
                        <span className="block truncate text-[11px] text-muted">
                          {app.members.length > 1 ? `${app.members.length} processus` : "1 processus"}
                          {app.windows > 0 && ` · ${app.windows} fenêtre${app.windows > 1 ? "s" : ""}`}
                          {app.hints > 0 && <span className="text-warn"> · ⚑ indice</span>}
                        </span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-[11px] tabular-nums leading-tight">
                        <span className="block" style={{ color: load >= 1 ? `var(--${loadTone(load)})` : "var(--muted)" }}>
                          {load < 10 ? load.toFixed(1) : Math.round(load)} %
                        </span>
                        <span className="block text-muted">{fmtBytes(app.rss)}</span>
                      </span>
                    </button>
                  );
                })}
            </section>
          );
        })}
      </div>
    </div>
  );
}
