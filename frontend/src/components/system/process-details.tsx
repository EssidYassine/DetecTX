"use client";

import { useState, type ReactNode } from "react";
import type { ProcInfo } from "@/lib/api";
import { fmtBytes, loadTone, machineLoad } from "@/lib/host";
import { hintsFor, type TreeNode } from "@/lib/proctree";
import { fmtAgo } from "@/lib/time";

export type ProcAction = "close" | "kill";
export type Notice = { tone: "ok" | "warn" | "critical"; text: string };

export interface ProcActions {
  busy: ProcAction | null;
  notice: Notice | null;
  onClose: (proc: ProcInfo) => void;
  onKill: (proc: ProcInfo, tree: boolean) => void;
}

const pct = (v: number) => `${v < 10 ? v.toFixed(1) : Math.round(v)} %`;
const NOTICE_COLOR = { ok: "accent", warn: "warn", critical: "critical" } as const;

interface SelectionCardProps {
  selected: number | null;
  node: TreeNode | null;
  cpuCount: number;
  now: number;
  actions: ProcActions;
  onSelect: (pid: number | null) => void;
  emptyHint: string;
}

/** Zone « processus sélectionné » commune aux vues Ressources et Processus. */
export function SelectionCard({ selected, node, cpuCount, now, actions, onSelect, emptyHint }: SelectionCardProps) {
  return (
    <div className="border-b border-line px-4 py-3">
      {selected === null ? (
        <p className="text-xs text-muted">
          {emptyHint} <span className="font-mono">Échap</span> pour désélectionner.
        </p>
      ) : node === null ? (
        <p className="text-xs text-muted">
          Le PID {selected} n&apos;existe plus (terminé).{" "}
          <button onClick={() => onSelect(null)} className="text-accent hover:underline">
            Fermer
          </button>
        </p>
      ) : (
        // key : l'étape de confirmation repart de zéro à chaque changement de processus.
        <ProcessDetails key={node.proc.pid} node={node} cpuCount={cpuCount} now={now} actions={actions} onSelect={onSelect} />
      )}
      {actions.notice && (
        <p className="mt-2 text-xs" style={{ color: `var(--${NOTICE_COLOR[actions.notice.tone]})` }} role="status">
          {actions.notice.text}
        </p>
      )}
    </div>
  );
}

function ProcessDetails({
  node,
  cpuCount,
  now,
  actions,
  onSelect,
}: {
  node: TreeNode;
  cpuCount: number;
  now: number;
  actions: ProcActions;
  onSelect: (pid: number | null) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [withTree, setWithTree] = useState(false);
  const proc = node.proc;
  const load = machineLoad(proc.cpu_percent, cpuCount);
  const hints = hintsFor(node);
  const parent = node.parent?.proc ?? null;
  const busy = actions.busy !== null;

  return (
    <div>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-mono text-sm font-semibold">{proc.name ?? "—"}</p>
          <p className="text-[11px] text-muted">
            PID {proc.pid}
            {proc.status === "stopped" ? " · suspendu" : ""}
            {proc.threads !== null ? ` · ${proc.threads} threads` : ""}
          </p>
        </div>
        <button onClick={() => onSelect(null)} className="text-muted transition hover:text-foreground" aria-label="Désélectionner">
          ✕
        </button>
      </div>

      {hints.length > 0 && (
        <ul className="mt-2 space-y-1">
          {hints.map((h) => (
            <li key={h.id} className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-[11px] text-warn">
              ⚑ {h.label} <span className="font-mono opacity-80">· ATT&amp;CK {h.attack}</span>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
        <Field label="Chemin">
          <span className="break-all font-mono">{proc.exe ?? <span className="text-muted">inaccessible (droits)</span>}</span>
        </Field>
        <Field label="Parent">
          {parent ? (
            <button onClick={() => onSelect(parent.pid)} className="font-mono text-accent hover:underline">
              {parent.name ?? "?"} ({parent.pid})
            </button>
          ) : (
            <span className="text-muted">aucun (racine ou parent terminé)</span>
          )}
          {node.descendants > 0 && <span className="text-muted"> · {node.descendants} sous-processus</span>}
        </Field>
        <Field label="Utilisateur">
          <span className="font-mono">{proc.username ?? <span className="text-muted">—</span>}</span>
        </Field>
        <Field label="Démarré">{proc.started_at ? fmtAgo(proc.started_at, now) : "—"}</Field>
        <Field label="Charge">
          <span className="font-mono tabular-nums">
            CPU <span style={{ color: `var(--${loadTone(load)})` }}>{pct(load)}</span> · RAM {pct(proc.memory_percent)}
            {proc.rss !== null && <span className="text-muted"> ({fmtBytes(proc.rss)})</span>}
            {proc.io_bps !== null && <span> · E/S {fmtBytes(proc.io_bps)}/s</span>}
          </span>
        </Field>
      </dl>

      {confirming ? (
        <div className="mt-2.5 rounded-md border border-critical/40 bg-critical/10 p-2.5 text-[11px]">
          <p className="text-critical">
            Arrêt immédiat de <span className="font-mono">{proc.name ?? proc.pid}</span> : le programme ne pourra pas enregistrer.
          </p>
          {node.descendants > 0 && (
            <label className="mt-1.5 flex cursor-pointer items-center gap-2 text-foreground">
              <input type="checkbox" checked={withTree} onChange={(e) => setWithTree(e.target.checked)} className="accent-[var(--critical)]" />
              inclure ses {node.descendants} sous-processus
            </label>
          )}
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirming(false)} className="flex-1 rounded border border-line px-2 py-1 text-muted transition hover:text-foreground">
              Annuler
            </button>
            <button
              onClick={() => actions.onKill(proc, withTree && node.descendants > 0)}
              disabled={busy}
              className="flex-1 rounded bg-critical px-2 py-1 font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            >
              {actions.busy === "kill" ? "Arrêt…" : "Confirmer l'arrêt"}
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2.5 flex gap-2">
          <button
            onClick={() => actions.onClose(proc)}
            disabled={busy}
            title="Demande polie, comme la croix de la fenêtre : le programme peut proposer d'enregistrer"
            className="flex-1 rounded-md border border-line px-3 py-1.5 text-xs font-medium transition hover:border-accent/50 hover:text-accent disabled:opacity-50"
          >
            {actions.busy === "close" ? "Fermeture…" : "Fermer"}
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
