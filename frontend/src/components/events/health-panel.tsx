"use client";

import { useState } from "react";
import type { ChannelStatus, CollectionHealth } from "@/lib/api";
import { fmtAgo } from "@/lib/time";

const STATUS_TONE: Record<CollectionHealth["status"], string> = { ok: "accent", degraded: "warn", down: "critical" };
const STATUS_LABEL: Record<CollectionHealth["status"], string> = { ok: "collecte complète", degraded: "collecte partielle", down: "collecte arrêtée" };
const CHANNEL_TONE: Record<ChannelStatus, string> = { ok: "accent", quiet: "muted", stale: "warn", missing: "critical" };
const CHANNEL_LABEL: Record<ChannelStatus, string> = { ok: "à jour", quiet: "calme", stale: "en retard", missing: "absent" };

interface HealthPanelProps {
  health: CollectionHealth | null;
  email: string | null;
  now: number;
  className?: string;
}

/** Santé de la collecte : sans elle, « aucun événement » ne veut rien dire. */
export function HealthPanel({ health, email, now, className = "" }: HealthPanelProps) {
  const [help, setHelp] = useState(false);
  const status = health?.status ?? "down";
  const tone = STATUS_TONE[status];
  const needsHelp = health !== null && status !== "ok";

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-2 border-b border-line px-4 py-2.5">
        <span className="eyebrow">Santé de la collecte</span>
        {health && (
          <span
            className="rounded-full px-2 py-0.5 text-[10px] font-medium"
            style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}
          >
            {STATUS_LABEL[status]}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-xs">
        {!health ? (
          <p className="text-muted">Lecture de l&apos;état de la collecte…</p>
        ) : (
          <>
            <p style={{ color: `var(--${tone})` }}>{health.summary}</p>

            <dl className="mt-3 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-1.5">
              <dt className="text-muted">Agent</dt>
              <dd>
                {health.agent.last_seen ? (
                  <>
                    <span className="font-medium">{health.agent.computer}</span>
                    {health.agent.version && <span className="text-muted"> · v{health.agent.version}</span>}
                    <span className="text-muted"> · {health.agent.alive ? "actif" : "silencieux"}, vu {fmtAgo(health.agent.last_seen, now)}</span>
                    {health.agent.admin === false && <span className="block text-warn">sans droits administrateur</span>}
                  </>
                ) : (
                  <span className="text-muted">aucun agent connecté depuis le démarrage du serveur</span>
                )}
              </dd>
              <dt className="text-muted">Sysmon</dt>
              <dd style={{ color: health.sysmon.running ? undefined : "var(--warn)" }}>
                {health.sysmon.running ? `actif (${health.sysmon.service})` : health.sysmon.installed ? "installé mais arrêté" : "non installé"}
              </dd>
            </dl>

            <ul className="mt-3 space-y-1.5">
              {health.channels.map((c) => (
                <li key={c.channel} className="flex items-start gap-2">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--${CHANNEL_TONE[c.status]})` }} aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="font-medium">{c.label}</span>
                      <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">
                        {c.count_24h.toLocaleString("fr-FR")} / 24 h
                      </span>
                    </span>
                    <span className="block text-[11px] text-muted">
                      <span style={{ color: `var(--${CHANNEL_TONE[c.status]})` }}>{CHANNEL_LABEL[c.status]}</span>
                      {c.last_event && ` · dernier ${fmtAgo(c.last_event, now)}`}
                      {c.hint && ` · ${c.hint}`}
                    </span>
                  </span>
                </li>
              ))}
            </ul>

            {needsHelp && (
              <div className="mt-3 rounded-lg border border-line">
                <button onClick={() => setHelp((v) => !v)} aria-expanded={help} className="flex w-full items-center justify-between px-3 py-2 text-left font-medium">
                  Rétablir la collecte
                  <span className="text-muted">{help ? "▾" : "▸"}</span>
                </button>
                {help && (
                  <div className="space-y-3 border-t border-line px-3 py-2.5">
                    {!health.agent.alive && (
                      <Command
                        title="1. Démarrer l'agent (PowerShell administrateur, depuis le dossier du projet)"
                        command={`cd collectors\\agent; .\\detectx-agent.ps1 -Email ${email ?? "vous@poste.local"} -IntervalSec 15`}
                      />
                    )}
                    {!health.sysmon.installed && (
                      <Command title="2. Installer Sysmon (PowerShell administrateur)" command="powershell -ExecutionPolicy Bypass -File .\collectors\install-sysmon.ps1" />
                    )}
                    <p className="text-[11px] text-muted">
                      L&apos;agent demande votre mot de passe DeTecTX dans la console ; il renouvelle sa session seul et signale sa présence toutes les 15 s.
                    </p>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function Command({ title, command }: { title: string; command: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-1 text-[11px] text-muted">{title}</p>
      <div className="flex items-start gap-2 rounded-md bg-surface-2 px-2 py-1.5">
        <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{command}</code>
        <button
          onClick={() => {
            void navigator.clipboard.writeText(command).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
            });
          }}
          className="shrink-0 text-[11px] text-accent hover:underline"
        >
          {copied ? "copié" : "copier"}
        </button>
      </div>
    </div>
  );
}
