"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { approvePersistence, resetPersistenceBaseline, setPersistenceState, type PersistenceEntry, type PersistenceMechanism, type PersistenceSnapshot, type User } from "@/lib/api";
import { MECHANISM_LABEL, MECHANISMS, relTime, SCOPE_LABEL, signatureText, trust, TRUST_LABEL, TRUST_TONE, type Trust } from "@/lib/persistence";
import { ScenePoster } from "@/components/three/scene-poster";
import type { RootsHover } from "@/components/three/roots";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { NoticeLine, type Notice } from "./process-details";
import { RemedyAction } from "./remedy-action";

const Roots = dynamic(() => import("@/components/three/roots"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/roots_poster.png" />,
});

type Filter = "attention" | "third" | "all" | "off";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "attention", label: "À examiner" },
  { key: "third", label: "Hors Microsoft" },
  { key: "off", label: "Désactivées" },
  { key: "all", label: "Toutes" },
];
const TRUST_RANK: Record<Trust, number> = { new: 0, risky: 1, unknown: 2, signed: 3, microsoft: 4 };
const hoverKey = (h: RootsHover) => h.id;

function matches(e: PersistenceEntry, filter: Filter): boolean {
  const t = trust(e);
  if (filter === "attention") return t === "new" || t === "risky";
  if (filter === "third") return t !== "microsoft" && !e.builtin;
  if (filter === "off") return e.enabled === false;
  return true;
}

/** Pourquoi une entrée ne se désactive pas depuis DeTecTX, et où agir. */
function guidance(e: PersistenceEntry): string | null {
  if (e.mechanism === "driver") return "Pilote du noyau : il se retire en désinstallant le logiciel ou le périphérique qui l'a installé (Gestionnaire de périphériques). DeTecTX ne touche pas aux pilotes : une erreur peut empêcher Windows de démarrer.";
  if (e.mechanism === "wmi") return e.builtin ? "Abonnement présent d'origine sur Windows (journal du Gestionnaire de services)." : "Abonnement WMI permanent : technique furtive rarement légitime. À examiner puis supprimer depuis une console PowerShell administrateur (espace de noms root\\subscription).";
  if (e.mechanism === "run" && e.location.toLowerCase().includes("runonce")) return "Entrée RunOnce : exécutée une seule fois au prochain démarrage, puis effacée par Windows.";
  if ((e.mechanism === "task" || e.mechanism === "service") && (e.builtin || e.signature?.verdict === "microsoft")) return "Composant de Windows : laissé tel quel par DeTecTX.";
  return null;
}

interface PersistenceViewProps {
  snapshot: PersistenceSnapshot | null;
  error: string | null;
  user: User | null;
  runningPid: (path: string | null) => number | null;
  selected: string | null;
  onSelect: (id: string) => void;
  onChanged: () => Promise<void> | void;
  onOpenProcess: (pid: number) => void;
}

/** Vue Persistance : les racines (3D), la liste filtrable et la fiche d'une entrée. */
export function PersistenceView({ snapshot, error, user, runningPid, selected, onSelect, onChanged, onOpenProcess }: PersistenceViewProps) {
  const [filter, setFilter] = useState<Filter>("attention");
  const [focus, setFocus] = useState<PersistenceMechanism | null>(null);
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<RootsHover>(panel, hoverKey);

  const entries = useMemo(() => snapshot?.entries ?? [], [snapshot]);
  const counts = useMemo(() => {
    const out: Record<Filter, number> = { attention: 0, third: 0, off: 0, all: entries.length };
    for (const e of entries) for (const f of ["attention", "third", "off"] as const) if (matches(e, f)) out[f]++;
    return out;
  }, [entries]);
  // Rien à examiner : on ouvre directement sur les entrées hors Microsoft (plus parlant qu'une liste vide).
  const activeFilter: Filter = filter === "attention" && counts.attention === 0 ? "third" : filter;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entries
      .filter((e) => matches(e, activeFilter) && (!focus || e.mechanism === focus))
      .filter((e) => !needle || e.name.toLowerCase().includes(needle) || e.command.toLowerCase().includes(needle) || (e.signature?.publisher ?? "").toLowerCase().includes(needle))
      .sort((a, b) => TRUST_RANK[trust(a)] - TRUST_RANK[trust(b)] || a.mechanism.localeCompare(b.mechanism) || a.name.localeCompare(b.name));
  }, [entries, activeFilter, focus, q]);
  const current = entries.find((e) => e.id === selected) ?? shown[0] ?? null;
  const hovered = hover ? entries.find((e) => e.id === hover.id) : undefined;
  const isAdmin = user?.role === "admin";
  const canTriage = isAdmin || user?.role === "analyst";
  // Nouveautés à examiner (hors Microsoft) ; celles de Windows (mises à jour) sont seulement comptées.
  const fresh = entries.filter((e) => trust(e) === "new").length;
  const freshWindows = entries.filter((e) => e.status !== "baseline").length - fresh;

  async function act(work: () => Promise<string>) {
    setBusy(true);
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await work() });
      await onChanged();
    } catch (e) {
      setNotice({ tone: "critical", text: e instanceof Error ? e.message : "Action impossible." });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {/* Racines 3D */}
      <div ref={panel} className="panel relative flex min-h-0 flex-col overflow-hidden h-[26rem] lg:col-span-7 lg:row-span-2 lg:h-auto">
        <div className="flex items-center gap-2 border-b border-line px-4 py-2.5">
          <span className="eyebrow">Les racines du poste</span>
          <span className="ml-auto text-[11px] text-muted">
            {entries.length} entrées · référence du {relTime(snapshot?.baseline_at)}
            {fresh > 0 && <span className="ml-1.5 font-medium text-critical">· {fresh} nouvelle(s)</span>}
            {freshWindows > 0 && <span className="ml-1.5">· {freshWindows} de Windows</span>}
          </span>
        </div>
        <div className="relative min-h-0 flex-1">
          {snapshot ? (
            <Roots entries={entries} selected={current?.id ?? null} focus={focus} onHover={onHover} onSelect={onSelect} />
          ) : (
            <p className="px-6 pt-12 text-sm text-muted">{error ?? "Inventaire de ce qui se relance au démarrage…"}</p>
          )}
          <div className="pointer-events-auto absolute left-3 top-2.5 flex flex-wrap gap-1" role="group" aria-label="Mécanisme">
            {MECHANISMS.map((m) => (
              <button
                key={m.id}
                onClick={() => setFocus((f) => (f === m.id ? null : m.id))}
                aria-pressed={focus === m.id}
                title={m.how}
                className={`rounded-md border px-1.5 py-0.5 text-[10px] backdrop-blur transition ${focus === m.id ? "border-accent/60 bg-accent/15 text-accent" : "border-line bg-surface/60 text-muted hover:text-foreground"}`}
              >
                {m.short}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line px-4 py-2 text-[10px] text-muted">
          {(["new", "risky", "signed", "microsoft"] as const).map((t) => (
            <span key={t} className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: t === "microsoft" ? "#c9b48a" : `var(--${TRUST_TONE[t]})` }} />
              {TRUST_LABEL[t]}
            </span>
          ))}
          <span className="ml-auto">plus c&apos;est profond, plus c&apos;est privilégié</span>
        </div>
        {hover && hovered && (
          <HoverTip hover={hover} tipRef={tip}>
            <p className="font-medium">{hovered.name}</p>
            <p className="mt-0.5 text-muted">
              {MECHANISM_LABEL[hovered.mechanism]} · {SCOPE_LABEL[hovered.scope]}
              {hovered.enabled === false && " · désactivée"}
            </p>
            <p className="mt-0.5" style={{ color: `var(--${TRUST_TONE[trust(hovered)]})` }}>
              {signatureText(hovered.signature, hovered.target)}
            </p>
            <p className="mt-0.5 text-[10px] text-muted">Clic : fiche</p>
          </HoverTip>
        )}
      </div>

      {/* Liste */}
      <div className="panel flex min-h-0 flex-col overflow-hidden h-[24rem] lg:col-span-5 lg:h-auto">
        <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              aria-pressed={activeFilter === f.key}
              className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition ${activeFilter === f.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
            >
              {f.label}
              <span className={`font-mono text-[10px] ${f.key === "attention" && counts.attention ? "text-critical" : ""}`}>{counts[f.key]}</span>
            </button>
          ))}
          <input
            value={q}
            onChange={(e) => setQ(e.target.value.slice(0, 100))}
            placeholder="Filtrer…"
            aria-label="Filtrer les entrées"
            className="ml-auto w-28 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-xs outline-none focus:border-accent"
          />
        </div>
        {snapshot && filter === "attention" && counts.attention === 0 && (
          <p className="flex items-center gap-2 border-b border-line bg-accent/5 px-4 py-1.5 text-xs text-accent">
            <span aria-hidden="true">✓</span> Rien de nouveau ni de non signé depuis la référence.
          </p>
        )}
        <ul className="min-h-0 flex-1 overflow-y-auto">
          {shown.length === 0 && <li className="p-6 text-center text-sm text-muted">Aucune entrée pour ce filtre.</li>}
          {shown.slice(0, 400).map((e) => {
            const t = trust(e);
            const active = e.id === current?.id;
            return (
              <li key={e.id}>
                <button onClick={() => onSelect(e.id)} aria-current={active} className={`flex w-full items-center gap-2.5 border-b border-line/50 px-3 py-1.5 text-left transition ${active ? "bg-accent/10" : "hover:bg-surface-2/70"}`}>
                  <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: t === "microsoft" ? "#c9b48a" : `var(--${TRUST_TONE[t]})`, opacity: e.enabled === false ? 0.35 : 1 }} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-xs font-medium ${e.enabled === false ? "text-muted line-through decoration-muted/50" : ""}`}>{e.name}</span>
                    <span className="block truncate text-[10px] text-muted">
                      {MECHANISM_LABEL[e.mechanism]} · {e.signature?.publisher ?? signatureText(e.signature, e.target)}
                    </span>
                  </span>
                  {e.status !== "baseline" && <span className="shrink-0 rounded bg-critical/15 px-1.5 text-[10px] font-semibold text-critical">{e.status === "new" ? "nouveau" : "modifié"}</span>}
                </button>
              </li>
            );
          })}
        </ul>
        {isAdmin && (
          <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-[10px] text-muted">
            <span>Référence : ce qui était présent le {relTime(snapshot?.baseline_at)}</span>
            <button
              onClick={() => {
                if (window.confirm("Tout ce qui est présent maintenant deviendra « connu ». Continuer ?")) void act(async () => (await resetPersistenceBaseline(), "Nouvelle référence enregistrée."));
              }}
              disabled={busy}
              className="text-accent hover:underline disabled:opacity-50"
            >
              Nouvelle référence
            </button>
          </div>
        )}
      </div>

      {/* Fiche */}
      <div className="panel flex min-h-0 flex-col overflow-hidden h-[24rem] lg:col-span-5 lg:h-auto">
        {current ? (
          <EntryCard entry={current} busy={busy} notice={notice} isAdmin={isAdmin} canTriage={canTriage} pid={runningPid(current.target) ?? runningPid(current.image)} onOpenProcess={onOpenProcess} act={act} />
        ) : (
          <p className="m-auto p-6 text-center text-sm text-muted">Choisissez une entrée dans la liste ou sur une racine.</p>
        )}
      </div>
    </>
  );
}

function EntryCard({
  entry: e,
  busy,
  notice,
  isAdmin,
  canTriage,
  pid,
  onOpenProcess,
  act,
}: {
  entry: PersistenceEntry;
  busy: boolean;
  notice: Notice | null;
  isAdmin: boolean;
  canTriage: boolean;
  pid: number | null;
  onOpenProcess: (pid: number) => void;
  act: (work: () => Promise<string>) => Promise<void>;
}) {
  const t = trust(e);
  const tone = TRUST_TONE[t];
  const why = guidance(e);
  const toggleable = e.can_disable && !why;
  const off = e.enabled === false;
  return (
    <>
      <div className="border-b border-line px-4 py-2.5">
        <p className="text-[11px]" style={{ color: t === "microsoft" ? "#c9b48a" : `var(--${tone})` }}>
          {MECHANISM_LABEL[e.mechanism]} · {TRUST_LABEL[t]}
          {e.status !== "baseline" && ` · ${e.status === "new" ? "apparue" : "modifiée"} le ${relTime(e.changed_at)}`}
        </p>
        <p className="mt-0.5 truncate font-semibold" title={e.name}>
          {e.name}
          {off && <span className="ml-2 rounded bg-surface-2 px-1.5 text-[10px] font-normal text-muted">désactivée au démarrage</span>}
        </p>
      </div>
      <div className="min-h-0 flex-1 space-y-2.5 overflow-y-auto px-4 py-3 text-xs">
        <Field label="Commande">
          <code className="block max-h-20 overflow-y-auto break-all rounded bg-surface-2/70 px-2 py-1 font-mono text-[10px]">{e.command}</code>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Signature">
            <span style={{ color: t === "microsoft" ? undefined : `var(--${tone})` }}>{signatureText(e.signature, e.target)}</span>
          </Field>
          <Field label="Privilèges">
            {SCOPE_LABEL[e.scope]}
            {e.account ? ` · ${e.account}` : ""}
          </Field>
          <Field label="Déclenchement">{e.detail ?? "à l'ouverture de session"}</Field>
          <Field label="ATT&CK">
            <Link href={`/dashboard/mitre?mitre=${encodeURIComponent(e.attack)}`} className="font-mono text-accent hover:underline">
              {e.attack}
            </Link>
          </Field>
        </div>
        <Field label="Emplacement">
          <span className="break-all font-mono text-[10px] text-muted">{e.location}</span>
        </Field>
        {e.target && e.target !== e.image && (
          <Field label="Fichier réellement exécuté">
            <span className="break-all font-mono text-[10px]">{e.target}</span>
          </Field>
        )}
        {pid !== null && (
          <button onClick={() => onOpenProcess(pid)} className="text-accent hover:underline">
            En cours d&apos;exécution (PID {pid}) : voir le processus →
          </button>
        )}

        <div className="space-y-2 pt-1">
          {e.status !== "baseline" && canTriage && (
            <button
              onClick={() => void act(async () => (await approvePersistence(e.id), `« ${e.name} » ajoutée à la référence.`))}
              disabled={busy}
              className="w-full rounded-md border border-line px-3 py-1.5 text-xs transition hover:border-accent/60 hover:text-accent disabled:opacity-50"
            >
              Je l&apos;ai vérifiée : l&apos;ajouter à la référence
            </button>
          )}
          {toggleable && isAdmin && (
            <RemedyAction
              label={off ? "Réactiver au démarrage" : "Désactiver au démarrage"}
              title={`${off ? "Réactiver" : "Désactiver"} « ${e.name} » au démarrage`}
              change={`${MECHANISM_LABEL[e.mechanism]} · ${e.location}${e.mechanism === "service" ? " (type de démarrage : désactivé, service arrêté)" : ""}`}
              elevated={e.control?.hive !== "HKCU"}
              undoHint={off ? "« Désactiver au démarrage »" : "« Réactiver au démarrage »"}
              tone={off ? "accent" : t === "new" || t === "risky" ? "critical" : "warn"}
              busy={busy}
              onConfirm={() =>
                void act(async () => {
                  const r = await setPersistenceState(e.id, off);
                  return r.already ? "Déjà dans cet état." : r.detail;
                })
              }
            />
          )}
          {toggleable && !isAdmin && <p className="text-[11px] text-muted">Seul un administrateur DeTecTX peut la désactiver.</p>}
          {why && <p className="rounded-md bg-surface-2/60 px-2.5 py-1.5 text-[11px] text-muted">{why}</p>}
          <NoticeLine notice={notice} />
        </div>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted">{label}</p>
      <div>{children}</div>
    </div>
  );
}
