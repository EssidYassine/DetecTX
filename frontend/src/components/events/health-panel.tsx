"use client";

import { useState } from "react";
import type { ChannelStatus, CollectionHealth } from "@/lib/api";
import { fmtAgo } from "@/lib/time";

export const HEALTH_TONE: Record<CollectionHealth["status"], string> = { ok: "accent", degraded: "warn", down: "critical" };
export const HEALTH_LABEL: Record<CollectionHealth["status"], string> = { ok: "collecte complète", degraded: "collecte partielle", down: "collecte arrêtée" };
const CHANNEL_TONE: Record<ChannelStatus, string> = { ok: "accent", quiet: "muted", stale: "warn", missing: "critical" };
const CHANNEL_LABEL: Record<ChannelStatus, string> = { ok: "à jour", quiet: "calme", stale: "en retard", missing: "absent" };

/** Santé de la collecte (contenu de l'onglet) : sans elle, « aucun événement » ne veut rien dire. */
export function HealthView({ health, email, now }: { health: CollectionHealth | null; email: string | null; now: number }) {
  const [help, setHelp] = useState(false);
  if (!health) return <p className="text-xs text-muted">Lecture de l&apos;état de la collecte…</p>;

  const tone = HEALTH_TONE[health.status];
  const adminCollector = health.collectors.some((c) => c.alive && c.admin);
  const needsHelp = health.status !== "ok";

  return (
    <div className="text-xs">
      <p style={{ color: `var(--${tone})` }}>{health.summary}</p>

      <ul className="mt-3 space-y-1.5">
        {health.collectors.length === 0 && <li className="text-muted">Aucun collecteur ne s&apos;est signalé depuis le démarrage du serveur.</li>}
        {health.collectors.map((c) => (
          <li key={`${c.kind}-${c.computer}`} className="flex items-start gap-2">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--${c.alive ? "accent" : "critical"})` }} aria-hidden="true" />
            <span className="min-w-0">
              <span className="font-medium">{c.label}</span>
              <span className="text-muted">
                {" "}
                · {c.computer} · {c.alive ? "actif" : "silencieux"}, vu {fmtAgo(c.last_seen, now)}
                {c.admin === false && " · sans droits administrateur"}
              </span>
            </span>
          </li>
        ))}
        <li className="flex items-start gap-2">
          <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--${health.sysmon.running ? "accent" : "warn"})` }} aria-hidden="true" />
          <span>
            <span className="font-medium">Sysmon</span>
            <span className="text-muted"> · {health.sysmon.running ? `actif (${health.sysmon.service})` : health.sysmon.installed ? "installé mais arrêté" : "non installé"}</span>
          </span>
        </li>
      </ul>

      <p className="eyebrow mb-1.5 mt-4">Journaux</p>
      <ul className="space-y-1.5">
        {health.channels.map((c) => (
          <li key={c.channel} className="flex items-start gap-2">
            <span className="mt-1 h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: `var(--${CHANNEL_TONE[c.status]})` }} aria-hidden="true" />
            <span className="min-w-0 flex-1">
              <span className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{c.label}</span>
                <span className="shrink-0 font-mono text-[10px] tabular-nums text-muted">{c.count_24h.toLocaleString("fr-FR")} / 24 h</span>
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
            {health.status === "down" ? "Rétablir la collecte" : "Compléter la collecte"}
            <span className="text-muted">{help ? "▾" : "▸"}</span>
          </button>
          {help && (
            <div className="space-y-3 border-t border-line px-3 py-2.5">
              {health.status === "down" && (
                <p className="text-[11px] text-muted">
                  Le collecteur intégré démarre avec le backend DeTecTX : vérifiez que le serveur tourne et que LOCAL_COLLECTOR n&apos;est pas désactivé.
                </p>
              )}
              {!adminCollector && (
                <Command
                  title="Journal Sécurité + fichiers surveillés : agent en PowerShell administrateur, depuis le dossier du projet"
                  command={`cd collectors\\agent; .\\detectx-agent.ps1 -Email ${email ?? "vous@poste.local"} -IntervalSec 15`}
                />
              )}
              {!health.sysmon.installed && (
                <Command title="Processus, réseau, registre : installer Sysmon (PowerShell administrateur)" command="powershell -ExecutionPolicy Bypass -File .\collectors\install-sysmon.ps1" />
              )}
            </div>
          )}
        </div>
      )}
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
