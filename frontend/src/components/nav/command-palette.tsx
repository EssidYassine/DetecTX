"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchAlertCases, runDetection, type AlertCase } from "@/lib/api";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/cases";
import { NavGlyph, type NavIcon } from "./nav-icons";
import { NAV_SECTIONS } from "./sidebar";

interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: NavIcon;
  tone?: string;
  run: () => void | Promise<void>;
}

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  pinned: boolean;
  onTogglePin: () => void;
}

/** Palette Ctrl+K : aller à une page, agir, chercher dans les journaux ou ouvrir un dossier d'alertes. */
export function CommandPalette({ open, onClose, pinned, onTogglePin }: CommandPaletteProps) {
  if (!open) return null;
  return <PaletteBody onClose={onClose} pinned={pinned} onTogglePin={onTogglePin} />;
}

function PaletteBody({ onClose, pinned, onTogglePin }: Omit<CommandPaletteProps, "open">) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [cursor, setCursor] = useState(0);
  const [cases, setCases] = useState<{ q: string; items: AlertCase[] }>({ q: "", items: [] });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => input.current?.focus(), []);

  // Dossiers d'alertes correspondant au texte (requête différée).
  const query = q.trim();
  useEffect(() => {
    if (query.length < 2) return;
    let cancelled = false;
    const t = window.setTimeout(() => {
      fetchAlertCases({ q: query })
        .then((p) => !cancelled && setCases({ q: query, items: p.cases.slice(0, 5) }))
        .catch(() => undefined);
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [query]);

  const go = (href: string) => () => {
    router.push(href);
    onClose();
  };

  const commands = useMemo<Command[]>(() => {
    const needle = query.toLowerCase();
    const pages: Command[] = NAV_SECTIONS.flatMap((s) => s.items.map((i) => ({ id: `page:${i.href}`, group: "Aller à", label: i.label, hint: s.title, icon: i.icon, run: go(i.href) })));
    const actions: Command[] = [
      {
        id: "act:detect",
        group: "Actions",
        label: "Lancer la détection",
        hint: "exécute toutes les règles",
        icon: "alerts",
        run: async () => {
          setNotice("Analyse en cours…");
          try {
            const r = await runDetection();
            setNotice(`${r.rules_run} règles exécutées, ${r.alerts_created} nouvelle(s) alerte(s).`);
          } catch (e) {
            setNotice(e instanceof Error ? e.message : "Détection impossible");
          }
        },
      },
      { id: "act:rule", group: "Actions", label: "Créer une règle depuis les journaux", icon: "rules", run: go("/dashboard/events") },
      { id: "act:pin", group: "Actions", label: pinned ? "Détacher la barre latérale" : "Épingler la barre latérale", icon: "pin", run: () => { onTogglePin(); onClose(); } },
    ];
    const match = (c: Command) => !needle || c.label.toLowerCase().includes(needle) || (c.hint ?? "").toLowerCase().includes(needle);
    const out = [...pages.filter(match), ...actions.filter(match)];
    if (query.length >= 2) {
      out.push({ id: "search:logs", group: "Rechercher", label: `« ${query} » dans les journaux`, icon: "logs", run: go(`/dashboard/events?q=${encodeURIComponent(query.slice(0, 200))}`) });
      if (cases.q === query) {
        for (const c of cases.items) {
          out.push({ id: `case:${c.rule_id}`, group: "Dossiers d'alertes", label: c.rule_title, hint: `${SEVERITY_LABEL[c.severity]} · ×${c.count}`, icon: "alerts", tone: SEVERITY_TONE[c.severity], run: go(`/dashboard/alerts?case=${encodeURIComponent(c.rule_id)}`) });
        }
      }
    }
    return out;
    // `go` dépend seulement de router/onClose (stables) ; recalcul sur la saisie et les résultats.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, cases, pinned]);

  const selected = Math.min(cursor, Math.max(0, commands.length - 1));

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") onClose();
    else if (e.key === "ArrowDown") setCursor((selected + 1) % Math.max(1, commands.length));
    else if (e.key === "ArrowUp") setCursor((selected - 1 + commands.length) % Math.max(1, commands.length));
    else if (e.key === "Enter" && commands[selected]) void commands[selected].run();
    else return;
    e.preventDefault();
  }

  let lastGroup = "";
  return (
    <div className="fixed inset-0 z-[90] flex items-start justify-center bg-black/55 p-4 pt-[12vh]" onMouseDown={onClose}>
      <div role="dialog" aria-modal="true" aria-label="Palette de commandes" onMouseDown={(e) => e.stopPropagation()} className="w-full max-w-xl overflow-hidden rounded-2xl border border-line bg-surface shadow-2xl">
        <div className="flex items-center gap-3 border-b border-line px-4">
          <NavGlyph icon="search" className="h-4 w-4 text-muted" />
          <input
            ref={input}
            value={q}
            onChange={(e) => {
              setQ(e.target.value.slice(0, 200));
              setCursor(0);
            }}
            onKeyDown={onKey}
            placeholder="Page, action, texte à chercher dans les journaux, dossier d'alertes…"
            aria-label="Commande ou recherche"
            className="h-12 flex-1 bg-transparent text-sm outline-none"
          />
          <kbd className="rounded border border-line px-1.5 font-mono text-[10px] text-muted">Échap</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-2" role="listbox">
          {commands.length === 0 && <li className="px-3 py-6 text-center text-sm text-muted">Aucune commande.</li>}
          {commands.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id}>
                {header && <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-muted">{header}</p>}
                <button
                  role="option"
                  aria-selected={i === selected}
                  onMouseEnter={() => setCursor(i)}
                  onClick={() => void c.run()}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition ${i === selected ? "bg-accent/12 text-foreground" : "text-muted"}`}
                >
                  <NavGlyph icon={c.icon} className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate" style={c.tone ? { color: `var(--${c.tone})` } : undefined}>
                    {c.label}
                  </span>
                  {c.hint && <span className="shrink-0 text-[11px] text-muted">{c.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {notice && <p className="border-t border-line px-4 py-2 text-xs text-accent">{notice}</p>}
      </div>
    </div>
  );
}
