"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { loadTone, machineLoad } from "@/lib/host";
import { flatten, hintsFor, searchVisible, type Hint, type ProcTree, type TreeNode } from "@/lib/proctree";

interface TreePanelProps {
  tree: ProcTree | null;
  cpuCount: number;
  selected: number | null;
  onSelect: (pid: number | null) => void;
  className?: string;
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;

/** Arborescence parent -> enfants : qui a lancé quoi. Indices d'analyse signalés par ⚑. */
export function TreePanel({ tree, cpuCount, selected, onSelect, className = "" }: TreePanelProps) {
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [onlyHints, setOnlyHints] = useState(false);
  const list = useRef<HTMLDivElement>(null);

  const hints = useMemo(() => {
    const map = new Map<number, Hint[]>();
    tree?.byPid.forEach((node) => {
      const h = hintsFor(node);
      if (h.length > 0) map.set(node.proc.pid, h);
    });
    return map;
  }, [tree]);

  const { rows, expanded } = useMemo(() => {
    if (!tree) return { rows: [], expanded: () => false };
    let visible = searchVisible(tree, query);
    if (onlyHints) {
      // Processus signalés + leurs ancêtres (le chemin de lancement fait partie de l'indice).
      const path = new Set<number>();
      hints.forEach((_, pid) => {
        for (let n: TreeNode | null = tree.byPid.get(pid) ?? null; n; n = n.parent) path.add(n.proc.pid);
      });
      visible = path;
    }
    // Les ancêtres du processus sélectionné restent dépliés (sélection depuis la ville, un lien parent…).
    const effective = new Set(collapsed);
    for (let n = selected === null ? null : (tree.byPid.get(selected)?.parent ?? null); n; n = n.parent) effective.delete(n.proc.pid);
    // Recherche / filtre : tout le chemin est déplié, sinon on respecte les nœuds repliés.
    const folded = visible ? new Set<number>() : effective;
    return { rows: flatten(tree, folded, visible), expanded: (pid: number) => !folded.has(pid) };
  }, [tree, query, onlyHints, hints, collapsed, selected]);

  useEffect(() => {
    if (selected === null) return;
    list.current?.querySelector<HTMLElement>(`[data-pid="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  const toggle = (pid: number) =>
    setCollapsed((c) => {
      const next = new Set(c);
      if (next.has(pid)) next.delete(pid);
      else next.add(pid);
      return next;
    });
  const collapseAll = () => setCollapsed(new Set([...(tree?.byPid.values() ?? [])].filter((n) => n.children.length > 0).map((n) => n.proc.pid)));

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <span className="eyebrow">Arborescence</span>
        <span className="text-xs text-muted">{tree ? `${tree.byPid.size} processus · ${tree.roots.length} racines` : "chargement…"}</span>
        <div className="ml-auto flex items-center gap-2">
          <button
            onClick={() => setOnlyHints((v) => !v)}
            disabled={hints.size === 0}
            aria-pressed={onlyHints}
            className={`rounded-md border px-2 py-1 text-xs transition disabled:opacity-40 ${
              onlyHints ? "border-warn/50 bg-warn/15 text-warn" : "border-line text-muted hover:text-foreground"
            }`}
          >
            ⚑ {hints.size} indice{hints.size > 1 ? "s" : ""}
          </button>
          <button onClick={collapseAll} className="rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:text-foreground">
            Replier
          </button>
          <button onClick={() => setCollapsed(new Set())} className="rounded-md border border-line px-2 py-1 text-xs text-muted transition hover:text-foreground">
            Déplier
          </button>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Nom, PID ou chemin…"
            aria-label="Rechercher un processus"
            className="w-44 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs outline-none focus:border-accent"
          />
        </div>
      </div>

      <div ref={list} role="tree" aria-label="Arborescence des processus" className="min-h-0 flex-1 overflow-y-auto py-1 font-mono text-xs">
        {rows.length === 0 && <p className="px-4 py-6 text-center text-muted">{tree ? "Aucun processus ne correspond." : "Chargement…"}</p>}
        {rows.map(({ node, depth }) => {
          const p = node.proc;
          const load = machineLoad(p.cpu_percent, cpuCount);
          const flagged = hints.get(p.pid);
          const open = expanded(p.pid);
          const active = p.pid === selected;
          return (
            <div
              key={p.pid}
              data-pid={p.pid}
              role="treeitem"
              aria-level={depth + 1}
              aria-selected={active}
              aria-expanded={node.children.length > 0 ? open : undefined}
              onClick={() => onSelect(active ? null : p.pid)}
              className={`flex h-6 cursor-pointer items-center pr-4 transition-colors ${active ? "bg-accent/15" : "hover:bg-surface-2"}`}
            >
              <span className="w-3 shrink-0" />
              {Array.from({ length: depth }, (_, i) => (
                <span key={i} className="h-full w-4 shrink-0 border-l border-line/60" />
              ))}
              {node.children.length > 0 ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle(p.pid);
                  }}
                  aria-label={open ? "Replier" : "Déplier"}
                  className="w-4 shrink-0 text-muted hover:text-foreground"
                >
                  {open ? "▾" : "▸"}
                </button>
              ) : (
                <span className="w-4 shrink-0" />
              )}
              <span className={`truncate ${p.exe === null ? "text-muted" : ""}`} title={p.exe ?? "chemin inaccessible"}>
                {p.name ?? "—"}
              </span>
              <span className="ml-2 shrink-0 text-[10px] text-muted">{p.pid}</span>
              {!open && node.descendants > 0 && <span className="ml-2 shrink-0 text-[10px] text-muted">+{node.descendants}</span>}
              {flagged && (
                <span className="ml-2 shrink-0 text-warn" title={flagged.map((h) => h.label).join("\n")}>
                  ⚑
                </span>
              )}
              <span className="ml-auto w-14 shrink-0 text-right tabular-nums" style={{ color: load >= 1 ? `var(--${loadTone(load)})` : "var(--muted)" }}>
                {pct(load)}
              </span>
              <span className="w-14 shrink-0 text-right tabular-nums">{pct(p.memory_percent)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
