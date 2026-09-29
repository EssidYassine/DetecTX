"use client";

import { createContext, useContext, useState, type ReactNode } from "react";
import type { PersistenceEntry, ProcInfo } from "@/lib/api";
import { appRootOf, exeKey, subtree } from "@/lib/apps";
import { fmtBytes, loadTone, machineLoad } from "@/lib/host";
import { hintsFor, type TreeNode } from "@/lib/proctree";
import { fmtAgo } from "@/lib/time";
import { MECHANISM_LABEL, signatureText } from "@/lib/persistence";

/** Entrée de persistance qui relance cet exécutable au démarrage (fournie par la page Système). */
export const StartupLookup = createContext<{ find: (exe: string | null) => PersistenceEntry | null; open: (id: string) => void }>({ find: () => null, open: () => undefined });

const SIG_TONE = { microsoft: "muted", signed: "cyan", unsigned: "warn", invalid: "warn", unknown: "muted" } as const;

export type ProcAction = "close" | "kill";
export type Notice = { tone: "ok" | "warn" | "critical"; text: string };

export interface ProcActions {
  busy: ProcAction | null;
  notice: Notice | null;
  /** Fermeture propre de `target` (le processus qui possède la fenêtre). */
  onClose: (target: ProcInfo) => void;
  /** Arrêt forcé de `target`, avec ou sans ses sous-processus. */
  onKill: (target: ProcInfo, tree: boolean) => void;
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;
const NOTICE_COLOR = { ok: "accent", warn: "warn", critical: "critical" } as const;

export function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null;
  const color = `var(--${NOTICE_COLOR[notice.tone]})`;
  return (
    <p className="mt-2 rounded-md px-2.5 py-1.5 text-xs" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)` }} role="status">
      {notice.text}
    </p>
  );
}

interface SelectionCardProps {
  selected: number | null;
  node: TreeNode | null;
  cpuCount: number;
  now: number;
  actions: ProcActions;
  onSelect: (pid: number | null) => void;
  emptyHint: string;
  compact?: boolean;
}

/** Zone « processus sélectionné » : vide, processus disparu, ou fiche détaillée. */
export function SelectionCard({ selected, node, cpuCount, now, actions, onSelect, emptyHint, compact = false }: SelectionCardProps) {
  return (
    <div className="px-4 pt-3">
      {selected === null ? (
        <p className="pb-3 text-xs text-muted">
          {emptyHint} <span className="font-mono">Échap</span> pour désélectionner.
        </p>
      ) : node === null ? (
        <p className="pb-3 text-xs text-muted">
          Le PID {selected} n&apos;existe plus.{" "}
          <button onClick={() => onSelect(null)} className="text-accent hover:underline">
            Fermer
          </button>
        </p>
      ) : (
        // key : l'étape de confirmation repart de zéro à chaque changement de processus.
        <ProcessDetails key={node.proc.pid} node={node} cpuCount={cpuCount} now={now} actions={actions} onSelect={onSelect} compact={compact} />
      )}
      {node === null && <NoticeLine notice={actions.notice} />}
    </div>
  );
}

type Scope = "app" | "subtree" | "self";

function ProcessDetails({
  node,
  cpuCount,
  now,
  actions,
  onSelect,
  compact,
}: {
  node: TreeNode;
  cpuCount: number;
  now: number;
  actions: ProcActions;
  onSelect: (pid: number | null) => void;
  compact: boolean;
}) {
  const proc = node.proc;
  const app = appRootOf(node);
  const isSub = app !== node;
  const appTree = subtree(app);
  const owner = (proc.windows ?? 0) > 0 ? node : (appTree.find((n) => (n.proc.windows ?? 0) > 0) ?? null);
  const hasWindow = (proc.windows ?? 0) > 0;

  // Portées possibles de l'arrêt forcé, la plus sûre pour l'utilisateur en premier.
  const scopes: { key: Scope; label: string; target: TreeNode; tree: boolean }[] = [];
  if (isSub || node.descendants > 0) scopes.push({ key: "app", label: `Toute l'application · ${appTree.length} processus`, target: app, tree: true });
  if (isSub && node.descendants > 0) scopes.push({ key: "subtree", label: node.descendants === 1 ? "Ce processus et son sous-processus" : `Ce processus et ses ${node.descendants} sous-processus`, target: node, tree: true });
  scopes.push({ key: "self", label: "Ce processus seulement", target: node, tree: false });

  const [confirming, setConfirming] = useState(false);
  const [scope, setScope] = useState<Scope>(scopes[0].key);
  const chosen = scopes.find((s) => s.key === scope) ?? scopes[0];
  const doomed = chosen.tree ? subtree(chosen.target) : [chosen.target];
  // Autres programmes emportés par l'arrêt de l'arborescence (ex. un terminal et ses shells).
  const collateral = [...new Set(doomed.filter((n) => exeKey(n.proc) !== exeKey(app.proc)).map((n) => n.proc.name ?? `PID ${n.proc.pid}`))];
  const leavesEmptyWindow = chosen.key === "self" && isSub && owner !== null && owner !== node;

  const load = machineLoad(proc.cpu_percent, cpuCount);
  const hints = hintsFor(node);
  const parent = node.parent?.proc ?? null;
  const busy = actions.busy !== null;
  const startup = useContext(StartupLookup);
  const persisted = startup.find(proc.exe);
  const [fullCmd, setFullCmd] = useState(false);

  return (
    <div>
      <div className="flex items-start gap-3">
        <Avatar name={proc.name} tone={hints.length > 0 ? "warn" : proc.exe === null ? "muted" : "accent"} />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{proc.name ?? "—"}</p>
          <p className="truncate text-[11px] text-muted">
            PID {proc.pid} ·{" "}
            {isSub ? (
              <>
                sous-processus de{" "}
                <button onClick={() => onSelect(app.proc.pid)} className="text-accent hover:underline">
                  {app.proc.name} ({app.proc.pid})
                </button>
              </>
            ) : node.descendants > 0 ? (
              `processus principal · ${node.descendants} sous-processus`
            ) : (
              "processus unique"
            )}
          </p>
        </div>
        <button onClick={() => onSelect(null)} className="text-muted transition hover:text-foreground" aria-label="Désélectionner">
          ✕
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        {hasWindow && <Badge tone="cyan">▣ possède la fenêtre</Badge>}
        {proc.status === "stopped" && <Badge tone="warn">suspendu</Badge>}
        {proc.exe === null && <Badge tone="muted">chemin inaccessible</Badge>}
        {proc.signature && proc.exe && (
          <Badge tone={SIG_TONE[proc.signature.verdict]} title={signatureText(proc.signature, proc.exe)}>
            {proc.signature.verdict === "unsigned" || proc.signature.verdict === "invalid" ? "⚠ " : "✓ "}
            {signatureText(proc.signature, proc.exe)}
          </Badge>
        )}
        {persisted && (
          <button onClick={() => startup.open(persisted.id)} className="max-w-full" title="Voir l'entrée de persistance">
            <Badge tone="cyan">↻ se relance au démarrage · {MECHANISM_LABEL[persisted.mechanism]}</Badge>
          </button>
        )}
        {hints.map((h) => (
          <Badge key={h.id} tone="warn" title={h.label}>
            ⚑ {h.label} · {h.attack}
          </Badge>
        ))}
      </div>

      {!compact && (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Tile label="CPU" value={pct(load)} tone={load >= 1 ? loadTone(load) : undefined} />
          <Tile label="Mémoire" value={proc.rss !== null ? fmtBytes(proc.rss) : pct(proc.memory_percent)} />
          <Tile label="E/S" value={proc.io_bps !== null ? `${fmtBytes(proc.io_bps)}/s` : "—"} />
        </div>
      )}

      <dl className="mt-3 grid grid-cols-[5.5rem_1fr] gap-x-3 gap-y-1.5 text-xs">
        {compact && (
          <Field label="Charge">
            <span className="font-mono tabular-nums">
              CPU <span style={{ color: `var(--${loadTone(load)})` }}>{pct(load)}</span> · RAM {proc.rss !== null ? fmtBytes(proc.rss) : pct(proc.memory_percent)}
            </span>
          </Field>
        )}
        <Field label="Chemin">
          {proc.exe ? (
            <code className="block break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-snug">{proc.exe}</code>
          ) : (
            <span className="text-muted">inaccessible sans droits administrateur</span>
          )}
        </Field>
        <Field label="Commande">
          {proc.cmdline ? (
            <button onClick={() => setFullCmd((v) => !v)} className="block w-full text-left" title={fullCmd ? "Réduire" : "Afficher la commande complète"}>
              <code className={`block break-all rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] leading-snug ${fullCmd ? "" : "line-clamp-2"}`}>{proc.cmdline}</code>
            </button>
          ) : (
            <span className="text-muted">{proc.exe === null ? "protégée (processus système)" : "—"}</span>
          )}
        </Field>
        <Field label="Lancé par">
          {parent ? (
            <button onClick={() => onSelect(parent.pid)} className="text-accent hover:underline">
              {parent.name ?? "?"} <span className="font-mono text-muted">({parent.pid})</span>
            </button>
          ) : (
            <span className="text-muted">parent terminé</span>
          )}
        </Field>
        <Field label="Utilisateur">{proc.username ?? <span className="text-muted">—</span>}</Field>
        <Field label="Démarré">{proc.started_at ? fmtAgo(proc.started_at, now) : "—"}</Field>
      </dl>

      {/* Actions épinglées en bas du panneau : toujours visibles, même si la fiche défile. */}
      <div className="sticky bottom-0 -mx-4 mt-3 border-t border-line bg-surface px-4 py-2.5">
        {confirming ? (
          <div className="rounded-lg border border-critical/40 bg-critical/5 p-3 text-xs">
            <p className="font-medium text-critical">Arrêt immédiat, sans enregistrement</p>
            {scopes.length > 1 && (
              <fieldset className="mt-2 space-y-1.5">
                <legend className="sr-only">Portée de l&apos;arrêt</legend>
                {scopes.map((s) => (
                  <label key={s.key} className="flex cursor-pointer items-center gap-2">
                    <input type="radio" name={`scope-${proc.pid}`} checked={scope === s.key} onChange={() => setScope(s.key)} className="accent-[var(--critical)]" />
                    <span>{s.label}</span>
                  </label>
                ))}
              </fieldset>
            )}
            {leavesEmptyWindow && <p className="mt-2 text-warn">⚠ La fenêtre de {app.proc.name} restera ouverte mais vide : elle appartient au processus principal.</p>}
            {collateral.length > 0 && (
              <p className="mt-2 text-muted">
                Emporte aussi : {collateral.slice(0, 6).join(", ")}
                {collateral.length > 6 ? "…" : ""}
              </p>
            )}
            <div className="mt-3 flex gap-2">
              <button onClick={() => setConfirming(false)} className="flex-1 rounded-md border border-line px-2 py-1.5 text-muted transition hover:text-foreground">
                Annuler
              </button>
              <button
                onClick={() => actions.onKill(chosen.target.proc, chosen.tree)}
                disabled={busy}
                className="flex-1 rounded-md bg-critical px-2 py-1.5 font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
              >
                {actions.busy === "kill" ? "Arrêt…" : doomed.length > 1 ? `Arrêter ${doomed.length} processus` : "Arrêter"}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex gap-2">
            <button
              onClick={() => owner && actions.onClose(owner.proc)}
              disabled={busy || owner === null}
              title={
                owner === null
                  ? "Aucune fenêtre dans cette application : utilisez « Forcer l'arrêt »"
                  : "Demande polie, comme la croix de la fenêtre : le programme peut proposer d'enregistrer"
              }
              className="flex-1 truncate rounded-md border border-line px-3 py-1.5 text-xs font-medium transition hover:border-accent/50 hover:text-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {actions.busy === "close" ? "Fermeture…" : owner && owner !== node ? `Fermer ${app.proc.name}` : "Fermer"}
            </button>
            <button
              onClick={() => setConfirming(true)}
              disabled={busy}
              title="Arrêt immédiat (TerminateProcess), sans enregistrement"
              className="flex-1 rounded-md border border-critical/40 px-3 py-1.5 text-xs font-medium text-critical transition hover:bg-critical/10 disabled:opacity-50"
            >
              Forcer l&apos;arrêt
            </button>
          </div>
        )}
        <NoticeLine notice={actions.notice} />
      </div>
    </div>
  );
}

export function Avatar({ name, tone = "accent" }: { name: string | null; tone?: "accent" | "warn" | "muted" }) {
  const letter = (name ?? "?").replace(/[^a-z0-9]/gi, "").charAt(0).toUpperCase() || "?";
  return (
    <span
      className="grid h-8 w-8 shrink-0 place-items-center rounded-lg font-display text-sm font-semibold"
      style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}
      aria-hidden="true"
    >
      {letter}
    </span>
  );
}

function Badge({ tone, title, children }: { tone: "cyan" | "warn" | "muted"; title?: string; children: ReactNode }) {
  const color = tone === "cyan" ? "#22d3ee" : `var(--${tone})`;
  return (
    <span title={title} className="max-w-full truncate rounded-full px-2 py-0.5 text-[10px] font-medium" style={{ color, backgroundColor: `color-mix(in srgb, ${color} 13%, transparent)` }}>
      {children}
    </span>
  );
}

function Tile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg bg-surface-2 px-2.5 py-1.5">
      <p className="eyebrow">{label}</p>
      <p className="font-mono text-sm tabular-nums" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </>
  );
}
