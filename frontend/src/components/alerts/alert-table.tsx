"use client";

import { useEffect, useMemo, useState } from "react";
import { searchAlerts, triageAlerts, type Alert, type Resolution, type TriageInput } from "@/lib/api";
import { SEVERITY_LABEL, SEVERITY_TONE } from "@/lib/cases";
import { StatusPill } from "@/components/triage-actions";
import { RESOLUTION_LABEL, RESOLUTIONS } from "@/lib/triage";
import { fmtAgo } from "@/lib/time";
import type { QueueQuery } from "./case-list";

const PAGE_SIZE = 25;
const SHORTCUT_RESOLUTION: Record<string, Resolution> = { f: "false_positive", v: "true_positive", b: "benign" };

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

interface AlertTableProps {
  query: QueueQuery;
  refreshKey: number;
  /** Ligne choisie : la page ouvre le dossier (règle) de cette alerte. */
  onOpen: (alert: Alert) => void;
  onTriaged: () => void;
  now: number;
}

/** Vue « Alertes » : une ligne par alerte, sélection multiple et triage groupé. */
export function AlertTable({ query, refreshKey, onOpen, onTriaged, now }: AlertTableProps) {
  const queryKey = JSON.stringify(query);
  const [pageState, setPageState] = useState({ key: queryKey, page: 0 });
  const page = pageState.key === queryKey ? pageState.page : 0; // tout changement de filtre ramène à la page 1
  const setPage = (p: number) => setPageState({ key: queryKey, page: p });

  // Chargement : l'état « en cours » est dérivé (clé demandée ≠ clé reçue), pas posé dans l'effet.
  const requestKey = JSON.stringify({ queryKey, page, refreshKey });
  const [loaded, setLoaded] = useState<{ key: string; items: Alert[]; total: number; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    searchAlerts({
      offset: page * PAGE_SIZE,
      limit: PAGE_SIZE,
      status: query.status === "all" ? undefined : query.status,
      severity: query.severity,
      mitre: query.mitre ?? undefined,
      since: query.day?.since,
      until: query.day?.until,
      q: query.q || undefined,
    })
      .then((p) => !cancelled && setLoaded({ key: requestKey, items: p.items, total: p.total, error: null }))
      .catch((e) => !cancelled && setLoaded({ key: requestKey, items: [], total: 0, error: e instanceof Error ? e.message : "Erreur" }));
    return () => {
      cancelled = true;
    };
  }, [requestKey, query, page]);
  const loading = loaded?.key !== requestKey;
  const items = useMemo(() => loaded?.items ?? [], [loaded]);
  const total = loaded?.total ?? 0;

  // Sélection et ligne active (réinitialisées quand la liste change).
  const [sel, setSel] = useState<{ key: string; ids: Set<number>; focus: number }>({ key: "", ids: new Set(), focus: 0 });
  const selection = sel.key === requestKey ? sel : { key: requestKey, ids: new Set<number>(), focus: 0 };
  const focus = Math.min(selection.focus, Math.max(0, items.length - 1));
  const setSelection = (patch: Partial<{ ids: Set<number>; focus: number }>) => setSel({ ...selection, ...patch, key: requestKey });

  const [notice, setNotice] = useState<{ text: string; tone: "accent" | "critical" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [closeMenu, setCloseMenu] = useState(false);

  async function apply(input: TriageInput, ids: number[]) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await triageAlerts(ids, input);
      const what =
        input.status === "closed" && input.resolution
          ? `clôturée(s) · ${RESOLUTION_LABEL[input.resolution].toLowerCase()}`
          : input.status === "ack"
            ? "prise(s) en charge"
            : "rouverte(s)";
      setNotice({ text: `${res.updated} alerte(s) ${what}.`, tone: "accent" });
      setCloseMenu(false);
      onTriaged();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Triage impossible", tone: "critical" });
    } finally {
      setBusy(false);
    }
  }

  const targets = (): number[] => (selection.ids.size > 0 ? [...selection.ids] : items[focus] ? [items[focus].id] : []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const key = e.key.toLowerCase();
      if (key === "j" || key === "arrowdown") setSelection({ focus: Math.min(focus + 1, items.length - 1) });
      else if (key === "k" || key === "arrowup") setSelection({ focus: Math.max(focus - 1, 0) });
      else if (key === "x") {
        const row = items[focus];
        if (!row) return;
        const ids = new Set(selection.ids);
        if (ids.has(row.id)) ids.delete(row.id);
        else ids.add(row.id);
        setSelection({ ids });
      } else if (key === "enter" && items[focus]) onOpen(items[focus]);
      else if (key === "a") void apply({ status: "ack" }, targets());
      else if (key === "r") void apply({ status: "new" }, targets());
      else if (key in SHORTCUT_RESOLUTION) void apply({ status: "closed", resolution: SHORTCUT_RESOLUTION[key] }, targets());
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const allOnPage = items.length > 0 && items.every((a) => selection.ids.has(a.id));
  const toggleAll = () => setSelection({ ids: allOnPage ? new Set() : new Set(items.map((a) => a.id)) });
  const from = total === 0 ? 0 : page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  const btn = "rounded-lg border border-line px-2.5 py-1 text-xs transition hover:border-accent/60 hover:text-accent disabled:opacity-50";

  return (
    <>
      {selection.ids.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line/60 bg-accent/5 px-4 py-1.5 text-xs">
          <span className="font-medium">{selection.ids.size} sélectionnée(s)</span>
          <button disabled={busy} onClick={() => apply({ status: "ack" }, [...selection.ids])} className={btn}>
            Prendre en charge
          </button>
          <button disabled={busy} onClick={() => setCloseMenu((v) => !v)} className={btn} aria-expanded={closeMenu}>
            Clôturer ▾
          </button>
          {closeMenu &&
            RESOLUTIONS.map((r) => (
              <button key={r} disabled={busy} onClick={() => apply({ status: "closed", resolution: r }, [...selection.ids])} className={btn}>
                {RESOLUTION_LABEL[r]}
              </button>
            ))}
          <button disabled={busy} onClick={() => apply({ status: "new" }, [...selection.ids])} className={btn}>
            Rouvrir
          </button>
          <button onClick={() => setSelection({ ids: new Set() })} className="ml-auto text-muted hover:text-foreground">
            ✕ désélectionner
          </button>
        </div>
      )}
      {notice && (
        <p className="border-b border-line/60 px-4 py-1 text-xs" style={{ color: `var(--${notice.tone})` }}>
          {notice.tone === "accent" ? "✓" : "⚠"} {notice.text}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-xs">
          <thead className="sticky top-0 z-10 bg-surface text-[10px] uppercase tracking-wide text-muted">
            <tr className="border-b border-line">
              <th className="w-9 px-3 py-1.5">
                <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Tout sélectionner sur la page" className="accent-[var(--accent)]" />
              </th>
              <th className="px-2 py-1.5 font-medium">Sévérité</th>
              <th className="px-2 py-1.5 font-medium">Règle</th>
              <th className="px-2 py-1.5 font-medium">MITRE</th>
              <th className="px-2 py-1.5 font-medium">Statut</th>
              <th className="px-3 py-1.5 text-right font-medium">Événement</th>
            </tr>
          </thead>
          <tbody className={loading ? "opacity-50" : ""}>
            {items.map((a, i) => (
              <tr
                key={a.id}
                onClick={() => {
                  setSelection({ focus: i });
                  onOpen(a);
                }}
                className={`cursor-pointer border-b border-line/50 transition ${i === focus ? "bg-surface-2 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-2/60"}`}
              >
                <td className="px-3 py-1.5" onClick={(e) => e.stopPropagation()}>
                  <input
                    type="checkbox"
                    checked={selection.ids.has(a.id)}
                    onChange={() => {
                      const ids = new Set(selection.ids);
                      if (ids.has(a.id)) ids.delete(a.id);
                      else ids.add(a.id);
                      setSelection({ ids, focus: i });
                    }}
                    aria-label={`Sélectionner l'alerte ${a.id}`}
                    className="accent-[var(--accent)]"
                  />
                </td>
                <td className="px-2 py-1.5">
                  <span className="text-[11px] font-medium" style={{ color: `var(--${SEVERITY_TONE[a.severity]})` }}>
                    {SEVERITY_LABEL[a.severity]}
                  </span>
                </td>
                <td className="max-w-md px-2 py-1.5">
                  <span className="block truncate font-medium" title={a.rule_title}>
                    {a.rule_title}
                  </span>
                  {a.message && <span className="block truncate font-mono text-[10px] text-muted">{a.message}</span>}
                </td>
                <td className="px-2 py-1.5 font-mono text-[11px] text-accent">{a.mitre ?? "—"}</td>
                <td className="px-2 py-1.5">
                  <StatusPill alert={a} />
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono text-[11px] tabular-nums text-muted">{fmtAgo(a.event_timestamp ?? a.created_at, now)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && <p className="p-6 text-center text-sm text-muted">{loaded?.error ?? "Aucune alerte pour ces filtres."}</p>}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-1.5 text-[11px] text-muted">
        <span className="hidden font-mono 2xl:inline">J/K · X sélectionner · A · F/V/B · R · Entrée ouvrir le dossier</span>
        <div className="ml-auto flex items-center gap-2">
          <span className="tabular-nums">
            {from}–{to} sur {total}
          </span>
          <button disabled={page === 0} onClick={() => setPage(page - 1)} className={btn} aria-label="Page précédente">
            ‹
          </button>
          <button disabled={to >= total} onClick={() => setPage(page + 1)} className={btn} aria-label="Page suivante">
            ›
          </button>
        </div>
      </div>
    </>
  );
}
