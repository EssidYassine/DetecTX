"use client";

import { useEffect, useMemo, useState } from "react";
import { searchAlerts, triageAlerts, type Alert, type AlertStatus, type Resolution, type TriageInput } from "@/lib/api";
import { SeverityBadge } from "@/components/ui";
import { StatusPill } from "@/components/triage-actions";
import { RESOLUTION_LABEL, RESOLUTIONS, STATUS_LABEL } from "@/lib/triage";
import { fmtAgo } from "@/lib/time";

export type Severity = Alert["severity"];

/** État de la requête du tableau (tout changement de filtre ramène à la page 1). */
export interface AlertQuery {
  status: AlertStatus | "all";
  severity: Severity | "all";
  mitre: string | null;
  day: { since: string; until: string; label: string } | null;
  q: string;
  page: number;
}

const PAGE_SIZE = 25;
const SEVERITY_FILTERS: { key: Severity | "all"; label: string }[] = [
  { key: "all", label: "Toutes" },
  { key: "critical", label: "Critique" },
  { key: "high", label: "Haute" },
  { key: "medium", label: "Moyenne" },
  { key: "low", label: "Faible" },
];
const DOT: Record<Severity, string> = {
  critical: "var(--critical)",
  high: "var(--warn)",
  medium: "var(--accent)",
  low: "var(--muted)",
};
const SHORTCUT_RESOLUTION: Record<string, Resolution> = { f: "false_positive", v: "true_positive", b: "benign" };

interface TriagePanelProps {
  query: AlertQuery;
  onQuery: (patch: Partial<AlertQuery>) => void;
  counts: { total: number; byStatus: Partial<Record<AlertStatus, number>> };
  refreshKey: number;
  /** Ouvre le détail d'une alerte (tiroir) ; les raccourcis sont suspendus pendant ce temps. */
  onOpen: (alert: Alert) => void;
  drawerOpen: boolean;
  /** Un triage a eu lieu : le parent rafraîchit compteurs et liste. */
  onTriaged: () => void;
  /** Heure de référence des dates relatives (fournie par la page, rendu pur). */
  now: number;
  className?: string;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
}

export function TriagePanel({ query, onQuery, counts, refreshKey, onOpen, drawerOpen, onTriaged, now, className = "" }: TriagePanelProps) {
  // Recherche : saisie immédiate, requête différée (300 ms).
  const [typed, setTyped] = useState(query.q);
  useEffect(() => {
    const t = window.setTimeout(() => {
      if (typed !== query.q) onQuery({ q: typed });
    }, 300);
    return () => window.clearTimeout(t);
  }, [typed, query.q, onQuery]);

  // Chargement : l'état « en cours » est dérivé (clé demandée ≠ clé reçue), pas posé dans l'effet.
  const requestKey = JSON.stringify({ ...query, refreshKey });
  const [loaded, setLoaded] = useState<{ key: string; items: Alert[]; total: number; error: string | null } | null>(null);
  useEffect(() => {
    let cancelled = false;
    searchAlerts({
      offset: query.page * PAGE_SIZE,
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
  }, [requestKey, query]);
  const loading = loaded?.key !== requestKey;
  const items = useMemo(() => loaded?.items ?? [], [loaded]);
  const total = loaded?.total ?? 0;

  // Sélection et ligne active (réinitialisées quand la liste change : clé de requête).
  const [sel, setSel] = useState<{ key: string; ids: Set<number>; focus: number }>({ key: "", ids: new Set(), focus: 0 });
  const selection = sel.key === requestKey ? sel : { key: requestKey, ids: new Set<number>(), focus: 0 };
  const focus = Math.min(selection.focus, Math.max(0, items.length - 1));
  const setSelection = (patch: Partial<{ ids: Set<number>; focus: number }>) => setSel({ ...selection, ...patch, key: requestKey });

  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "critical" } | null>(null);
  const [busy, setBusy] = useState(false);
  const [closeMenu, setCloseMenu] = useState(false);

  async function apply(input: TriageInput, ids: number[]) {
    if (ids.length === 0 || busy) return;
    setBusy(true);
    try {
      const res = await triageAlerts(ids, input);
      const what = input.status === "closed" && input.resolution
        ? `clôturée(s) · ${RESOLUTION_LABEL[input.resolution].toLowerCase()}`
        : input.status === "ack" ? "prise(s) en charge" : "rouverte(s)";
      setNotice({ text: `${res.updated} alerte(s) ${what}.`, tone: "ok" });
      setCloseMenu(false);
      onTriaged();
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Triage impossible", tone: "critical" });
    } finally {
      setBusy(false);
    }
  }

  const targets = (): number[] => (selection.ids.size > 0 ? [...selection.ids] : items[focus] ? [items[focus].id] : []);

  // Raccourcis clavier façon outil SOC (inactifs pendant la saisie ou si le détail est ouvert).
  useEffect(() => {
    if (drawerOpen) return;
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
  const from = total === 0 ? 0 : query.page * PAGE_SIZE + 1;
  const to = Math.min(total, (query.page + 1) * PAGE_SIZE);
  const tabs: { key: AlertStatus | "all"; label: string; n: number }[] = [
    { key: "new", label: "Nouvelles", n: counts.byStatus.new ?? 0 },
    { key: "ack", label: "En cours", n: counts.byStatus.ack ?? 0 },
    { key: "closed", label: "Clôturées", n: counts.byStatus.closed ?? 0 },
    { key: "all", label: "Toutes", n: counts.total },
  ];
  const btn = "rounded-lg border border-line px-2.5 py-1 text-xs transition hover:border-accent/60 hover:text-accent disabled:opacity-50";

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      {/* Onglets de statut + recherche */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <div className="flex gap-1" role="tablist" aria-label="Statut des alertes">
          {tabs.map((t) => (
            <button
              key={t.key}
              role="tab"
              aria-selected={query.status === t.key}
              onClick={() => onQuery({ status: t.key })}
              className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition ${
                query.status === t.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"
              }`}
            >
              {t.label}
              <span className="font-mono text-xs tabular-nums">{t.n}</span>
            </button>
          ))}
        </div>
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Rechercher une règle / un détail…"
          className="w-64 rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-sm outline-none focus:border-accent"
        />
      </div>

      {/* Filtres actifs (sévérité, MITRE, jour) */}
      <div className="flex flex-wrap items-center gap-2 border-b border-line/60 px-4 py-2">
        {SEVERITY_FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => onQuery({ severity: f.key })}
            className={`flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs transition ${
              query.severity === f.key ? "border-accent/60 bg-accent/10 text-accent" : "border-line text-muted hover:text-foreground"
            }`}
          >
            {f.key !== "all" && <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: DOT[f.key] }} />}
            {f.label}
          </button>
        ))}
        {query.mitre && <Chip label={`MITRE ${query.mitre}`} onClear={() => onQuery({ mitre: null })} />}
        {query.day && <Chip label={`Jour · ${query.day.label}`} onClear={() => onQuery({ day: null })} />}
      </div>

      {/* Barre d'actions groupées */}
      {selection.ids.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-line/60 bg-accent/5 px-4 py-2 text-sm">
          <span className="font-medium">{selection.ids.size} sélectionnée(s)</span>
          <button disabled={busy} onClick={() => apply({ status: "ack" }, [...selection.ids])} className={btn}>Prendre en charge</button>
          <button disabled={busy} onClick={() => setCloseMenu((v) => !v)} className={btn} aria-expanded={closeMenu}>Clôturer ▾</button>
          {closeMenu &&
            RESOLUTIONS.map((r) => (
              <button key={r} disabled={busy} onClick={() => apply({ status: "closed", resolution: r }, [...selection.ids])} className={btn}>
                {RESOLUTION_LABEL[r]}
              </button>
            ))}
          <button disabled={busy} onClick={() => apply({ status: "new" }, [...selection.ids])} className={btn}>Rouvrir</button>
          <button onClick={() => setSelection({ ids: new Set() })} className="ml-auto text-xs text-muted hover:text-foreground">✕ désélectionner</button>
        </div>
      )}

      {notice && (
        <p className="border-b border-line/60 px-4 py-1.5 text-xs" style={{ color: `var(--${notice.tone})` }}>
          {notice.tone === "ok" ? "✓" : "⚠"} {notice.text}
        </p>
      )}

      {/* Tableau (seule zone qui défile) */}
      <div className="min-h-0 flex-1 overflow-auto">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 z-10 bg-surface text-xs text-muted">
            <tr className="border-b border-line">
              <th className="w-10 px-4 py-2">
                <input type="checkbox" checked={allOnPage} onChange={toggleAll} aria-label="Tout sélectionner sur la page" className="accent-[var(--accent)]" />
              </th>
              <th className="px-2 py-2 font-medium">Sévérité</th>
              <th className="px-2 py-2 font-medium">Risque</th>
              <th className="px-2 py-2 font-medium">Règle</th>
              <th className="px-2 py-2 font-medium">MITRE</th>
              <th className="px-2 py-2 font-medium">Statut</th>
              <th className="px-4 py-2 text-right font-medium">Événement</th>
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
                className={`cursor-pointer border-b border-line/50 transition ${
                  i === focus ? "bg-surface-2 shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-surface-2/60"
                }`}
              >
                <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
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
                <td className="px-2 py-2"><SeverityBadge severity={a.severity} /></td>
                <td className="px-2 py-2 font-mono tabular-nums">{a.risk_score}</td>
                <td className="max-w-md truncate px-2 py-2" title={a.message ?? a.rule_title}>{a.rule_title}</td>
                <td className="px-2 py-2 font-mono text-xs text-accent">{a.mitre ?? "—"}</td>
                <td className="px-2 py-2"><StatusPill alert={a} /></td>
                <td className="whitespace-nowrap px-4 py-2 text-right font-mono text-xs tabular-nums text-muted">
                  {fmtAgo(a.event_timestamp ?? a.created_at, now)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!loading && items.length === 0 && (
          <p className="p-6 text-center text-sm text-muted">
            {loaded?.error ?? `Aucune alerte ${query.status === "all" ? "" : `« ${STATUS_LABEL[query.status]} »`} pour ces filtres.`}
          </p>
        )}
      </div>

      {/* Pagination + aide raccourcis */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-xs text-muted">
        <span className="hidden font-mono lg:inline">
          J/K naviguer · X sélectionner · A prendre en charge · F/V/B clôturer (faux/vrai positif, bénin) · R rouvrir · Entrée détail
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span className="tabular-nums">{from}–{to} sur {total}</span>
          <button disabled={query.page === 0} onClick={() => onQuery({ page: query.page - 1 })} className={btn} aria-label="Page précédente">‹</button>
          <button disabled={to >= total} onClick={() => onQuery({ page: query.page + 1 })} className={btn} aria-label="Page suivante">›</button>
        </div>
      </div>
    </div>
  );
}

function Chip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="flex items-center gap-1.5 rounded-full border border-accent/40 bg-accent/10 px-2.5 py-0.5 text-xs text-accent">
      {label}
      <button onClick={onClear} className="text-muted transition hover:text-foreground" aria-label={`Retirer le filtre ${label}`}>✕</button>
    </span>
  );
}
