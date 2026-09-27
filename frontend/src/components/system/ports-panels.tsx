"use client";

import { useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { ExposureSnapshot, FirewallProfile, PortExposure, PortVerdict, RiskLevel } from "@/lib/api";
import { ScenePoster } from "@/components/three/scene-poster";
import type { RampartHover } from "@/components/three/rampart";
import { portKey } from "@/lib/netmap";
import { HoverTip, usePanelHover } from "@/components/overview/hover-tip";
import { PanelShell } from "./panel-shell";

const Rampart = dynamic(() => import("@/components/three/rampart"), {
  ssr: false,
  loading: () => <ScenePoster src="/models/rampart_poster.png" />,
});

export const VERDICT_LABEL: Record<PortVerdict, string> = { open: "joignable", blocked: "bloqué", local: "local", unknown: "indéterminé" };
const VERDICT_TONE: Record<PortVerdict, string> = { open: "warn", blocked: "accent", local: "muted", unknown: "muted" };
const RISK_LABEL: Record<RiskLevel, string> = { critical: "critique", high: "élevé", medium: "moyen", low: "faible", info: "aucun" };
const RISK_TONE: Record<RiskLevel, string> = { critical: "critical", high: "warn", medium: "warn", low: "accent", info: "muted" };
const PROFILE_LABEL: Record<string, string> = { public: "Public", private: "Privé", domain: "Domaine" };
const byKey = (h: RampartHover) => h.key;

/** Le pare-feu protège-t-il le profil réseau actif ? */
export function firewallOn(snap: ExposureSnapshot | null): boolean {
  if (!snap?.available) return true;
  return snap.profiles.active.every((p) => snap.profiles.states[p]?.enabled !== false);
}

function Chip({ tone, children }: { tone: string; children: React.ReactNode }) {
  return (
    <span
      className="shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium"
      style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 14%, transparent)` }}
    >
      {children}
    </span>
  );
}

// ─────────────────────────────── scène
interface RampartPanelProps {
  snapshot: ExposureSnapshot | null;
  selected: string | null;
  onSelect: (key: string | null) => void;
  className?: string;
}

export function RampartPanel({ snapshot, selected, onSelect, className }: RampartPanelProps) {
  const panel = useRef<HTMLDivElement>(null);
  const [hover, onHover, tip] = usePanelHover<RampartHover>(panel, byKey);
  const ports = snapshot?.ports ?? [];
  const hovered = hover ? ports.find((p) => portKey(p) === hover.key) : undefined;
  const s = snapshot?.summary;

  return (
    <PanelShell
      panelRef={panel}
      title="Rempart · pare-feu Windows"
      className={className}
      aside={
        <span className="ml-auto hidden items-center gap-3 text-[11px] text-muted md:flex">
          <Legend color="var(--critical)" label="joignable (risque)" />
          <Legend color="var(--accent)" label="bloqué par le pare-feu" square />
          <Legend color="var(--muted)" label="local / indéterminé" square />
        </span>
      }
      footer={
        snapshot && !snapshot.available ? (
          <span className="text-warn">{snapshot.error ?? "Pare-feu illisible."} Exposition affichée sans garantie.</span>
        ) : (
          <span className="flex flex-wrap justify-between gap-x-4 gap-y-1">
            <span>
              <b className="font-mono" style={{ color: s?.open ? "var(--warn)" : undefined }}>{s?.open ?? "—"}</b> joignables depuis le réseau ·{" "}
              <b className="font-mono text-foreground">{s?.blocked ?? "—"}</b> bloqués par le pare-feu · <b className="font-mono text-foreground">{s?.local ?? "—"}</b> locaux
              {s?.unknown ? <> · {s.unknown} indéterminés</> : null}
            </span>
            <span>{snapshot ? `${snapshot.rules_count} règles entrantes analysées` : "lecture du pare-feu…"}</span>
          </span>
        )
      }
    >
      <Rampart ports={ports} firewallOn={firewallOn(snapshot)} selected={selected} onHover={onHover} onSelect={onSelect} />
      {hover && hovered && (
        <HoverTip hover={hover} tipRef={tip}>
          <span className="font-mono font-medium">
            {hovered.proto.toUpperCase()} {hovered.port}
          </span>
          <span className="ml-2">{hovered.risk.service}</span>
          <p className="mt-0.5">
            <span style={{ color: `var(--${VERDICT_TONE[hovered.verdict]})` }}>{VERDICT_LABEL[hovered.verdict]}</span>
            {hovered.verdict === "open" && (
              <span style={{ color: `var(--${RISK_TONE[hovered.risk.level]})` }}> · risque {RISK_LABEL[hovered.risk.level]}</span>
            )}
          </p>
          <p className="mt-0.5 truncate font-mono text-[10px] text-muted">{hovered.process ?? "processus inconnu"}</p>
        </HoverTip>
      )}
    </PanelShell>
  );
}

function Legend({ color, label, square = false }: { color: string; label: string; square?: boolean }) {
  return (
    <span className="flex items-center gap-1">
      <span className={`h-2 w-2 ${square ? "rounded-sm" : "rounded-full"}`} style={{ backgroundColor: color }} /> {label}
    </span>
  );
}

// ─────────────────────────────── liste + fiche + actions pare-feu
type Filter = "open" | "blocked" | "local" | "all" | "detectx";
type Target = { proto: "tcp" | "udp"; port: number };

export interface FirewallActions {
  busy: "block" | "unblock" | null;
  notice: { tone: "ok" | "warn" | "critical"; text: string } | null;
  onBlock: (targets: Target[], profiles: FirewallProfile[]) => void;
  onUnblock: (name: string) => void;
}

const ALL_PROFILES: FirewallProfile[] = ["domain", "private", "public"];
const WINDOWS_SHARING = new Set([135, 137, 138, 139, 445]);
/** Plage dynamique Windows : le programme change de port à chaque démarrage, un blocage par port ne tiendrait pas. */
const isDynamic = (port: number) => port >= 49152;
const NOTICE_TONE = { ok: "accent", warn: "warn", critical: "critical" } as const;

/** Règle DeTecTX qui bloque déjà ce port (le cas échéant). */
const detectxRuleOf = (port: PortExposure) => port.rules.find((r) => r.group === "DeTecTX" && r.action === "block");

function activeProfiles(snapshot: ExposureSnapshot | null): FirewallProfile[] {
  const active = (snapshot?.profiles.active ?? []).filter((p): p is FirewallProfile => (ALL_PROFILES as string[]).includes(p));
  return active.length ? active : ["public"];
}

function profilesLabel(profiles: string[]): string {
  return profiles.length === 3 ? "tous les réseaux" : profiles.map((p) => PROFILE_LABEL[p] ?? p).join(" + ");
}

interface PortsPanelProps {
  snapshot: ExposureSnapshot | null;
  selected: string | null;
  onSelect: (key: string | null) => void;
  onOpenProcess: (pid: number) => void;
  actions: FirewallActions;
  className?: string;
}

export function PortsPanel({ snapshot, selected, onSelect, onOpenProcess, actions, className = "" }: PortsPanelProps) {
  const ports = useMemo(() => snapshot?.ports ?? [], [snapshot]);
  const [filter, setFilter] = useState<Filter | null>(null);
  const effective: Filter = filter ?? (ports.some((p) => p.verdict === "open") ? "open" : "all");
  const shown =
    effective === "all" || effective === "detectx"
      ? ports
      : ports.filter((p) => (effective === "open" ? p.verdict === "open" || p.verdict === "unknown" : p.verdict === effective));
  const current = selected ? ports.find((p) => portKey(p) === selected) : undefined;
  const active = snapshot?.profiles.active ?? [];
  const network = snapshot?.networks[0];
  const isPublic = active.includes("public");
  const count = (v: PortVerdict) => ports.filter((p) => p.verdict === v).length;
  const risky = ports.filter((p) => p.verdict === "open" && !isDynamic(p.port) && (p.risk.level === "critical" || p.risk.level === "high"));
  const detectxRules = snapshot?.detectx_rules ?? [];

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="border-b border-line px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="eyebrow">Réseau actuel</span>
          {snapshot && (
            <Chip tone={firewallOn(snapshot) ? "accent" : "critical"}>{firewallOn(snapshot) ? "pare-feu actif" : "pare-feu désactivé"}</Chip>
          )}
        </div>
        <p className="mt-1 truncate text-sm">
          {network ? network.name : "—"}
          {active.length > 0 && <span className="text-muted"> · profil {active.map((a) => PROFILE_LABEL[a] ?? a).join(", ")}</span>}
        </p>
        {isPublic && <p className="mt-1 text-[11px] text-warn">Réseau Public : toute personne sur ce réseau peut tenter de joindre les ports ouverts.</p>}
      </div>

      {(actions.busy || actions.notice) && (
        <div className="border-b border-line px-4 py-2 text-xs" role="status">
          {actions.busy ? (
            <p className="flex items-center gap-2 text-accent">
              <span className="h-2 w-2 animate-ping rounded-full bg-accent" />
              {snapshot?.elevated ? "Modification du pare-feu…" : "Validez l'invite Windows (UAC) sur votre bureau pour autoriser la modification…"}
            </p>
          ) : (
            actions.notice && <p style={{ color: `var(--${NOTICE_TONE[actions.notice.tone]})` }}>{actions.notice.text}</p>
          )}
        </div>
      )}

      {risky.length > 0 && !current && <BulkBlock risky={risky} profiles={activeProfiles(snapshot)} actions={actions} />}

      {current && (
        <PortCard
          port={current}
          defaultProfiles={activeProfiles(snapshot)}
          actions={actions}
          onClose={() => onSelect(null)}
          onOpenProcess={onOpenProcess}
        />
      )}

      <div className="flex flex-wrap gap-1 border-b border-line px-3 py-2" role="tablist" aria-label="Filtrer les ports">
        {(
          [
            ["open", `Joignables (${count("open") + count("unknown")})`],
            ["blocked", `Bloqués (${count("blocked")})`],
            ["local", `Locaux (${count("local")})`],
            ["all", "Tous"],
            ["detectx", `Règles DeTecTX (${detectxRules.length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={effective === key}
            onClick={() => setFilter(key)}
            className={`rounded-lg px-2 py-0.5 text-[11px] transition ${effective === key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
          >
            {label}
          </button>
        ))}
      </div>

      {effective === "detectx" ? (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {detectxRules.length === 0 && (
            <li className="px-4 py-6 text-center text-xs text-muted">Aucune règle ajoutée par DeTecTX. Les blocages que vous ferez apparaîtront ici.</li>
          )}
          {detectxRules.map((r) => (
            <li key={r.name} className="flex items-center gap-3 px-4 py-1.5">
              <span className="min-w-0 flex-1">
                <span className="block truncate font-mono text-xs">
                  {r.proto.toUpperCase()} {r.ports.join(", ")}
                </span>
                <span className="block truncate text-[10px] text-muted">bloqué sur {profilesLabel(r.profiles)}</span>
              </span>
              <button
                onClick={() => actions.onUnblock(r.name)}
                disabled={actions.busy !== null}
                className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
              >
                Retirer
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <ul className="min-h-0 flex-1 overflow-y-auto py-1">
          {shown.length === 0 && <li className="px-4 py-6 text-center text-xs text-muted">{snapshot ? "Aucun port dans cette catégorie." : "Chargement…"}</li>}
          {shown.map((p) => {
            const key = portKey(p);
            return (
              <li key={key}>
                <button
                  onClick={() => onSelect(key === selected ? null : key)}
                  aria-current={key === selected}
                  className={`flex w-full items-center gap-3 px-4 py-1.5 text-left transition-colors ${key === selected ? "bg-accent/10" : "hover:bg-surface-2"}`}
                >
                  <span className="w-14 shrink-0 font-mono text-sm tabular-nums">{p.port}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium">{p.risk.service}</span>
                    <span className="block truncate font-mono text-[10px] text-muted">
                      {p.proto.toUpperCase()} · {p.process ?? "?"}
                    </span>
                  </span>
                  {detectxRuleOf(p) ? (
                    <Chip tone="accent">bloqué par DeTecTX</Chip>
                  ) : p.verdict === "open" ? (
                    <Chip tone={RISK_TONE[p.risk.level]}>{RISK_LABEL[p.risk.level]}</Chip>
                  ) : (
                    <Chip tone={VERDICT_TONE[p.verdict]}>{VERDICT_LABEL[p.verdict]}</Chip>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Blocage groupé des ports à risque élevé ou critique : une seule invite Windows. */
function BulkBlock({ risky, profiles, actions }: { risky: PortExposure[]; profiles: FirewallProfile[]; actions: FirewallActions }) {
  const [confirming, setConfirming] = useState(false);
  const targets = risky.map((p) => ({ proto: p.proto, port: p.port }));
  const unique = targets.filter((t, i) => targets.findIndex((u) => u.proto === t.proto && u.port === t.port) === i);
  return (
    <div className="border-b border-line bg-critical/5 px-4 py-2.5 text-xs">
      <p>
        <span className="font-semibold text-critical">{unique.length} port(s) à risque élevé</span> joignables depuis ce réseau :{" "}
        <span className="font-mono">{unique.map((t) => t.port).join(", ")}</span>
      </p>
      {confirming ? (
        <div className="mt-2">
          <p className="text-muted">
            DeTecTX va ajouter {unique.length} règle(s) « Bloquer » (entrant) sur le profil {profilesLabel(profiles)}. Vos règles existantes ne sont pas modifiées ;
            chaque blocage se retire en un clic.
          </p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => setConfirming(false)} className="flex-1 rounded-md border border-line px-2 py-1 text-muted transition hover:text-foreground">
              Annuler
            </button>
            <button
              onClick={() => {
                setConfirming(false);
                actions.onBlock(unique, profiles);
              }}
              disabled={actions.busy !== null}
              className="flex-1 rounded-md bg-critical px-2 py-1 font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
            >
              Bloquer {unique.length} port(s)
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setConfirming(true)}
          disabled={actions.busy !== null}
          className="mt-2 w-full rounded-md border border-critical/40 px-3 py-1.5 font-medium text-critical transition hover:bg-critical/10 disabled:opacity-50"
        >
          Bloquer ces ports sur le profil {profilesLabel(profiles)}
        </button>
      )}
    </div>
  );
}

function PortCard({
  port,
  defaultProfiles,
  actions,
  onClose,
  onOpenProcess,
}: {
  port: PortExposure;
  defaultProfiles: FirewallProfile[];
  actions: FirewallActions;
  onClose: () => void;
  onOpenProcess: (pid: number) => void;
}) {
  const exposed = port.verdict === "open" || port.verdict === "unknown";
  const ours = detectxRuleOf(port);
  return (
    <div className="max-h-[62%] shrink-0 overflow-y-auto border-b border-line px-4 py-3 text-xs">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            <span className="font-mono">{port.port}</span> · {port.risk.service}
          </p>
          <p className="text-[11px] text-muted">
            {port.proto.toUpperCase()} · écoute sur {port.binds.join(", ")}
          </p>
        </div>
        <button onClick={onClose} className="text-muted transition hover:text-foreground" aria-label="Fermer la fiche">
          ✕
        </button>
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5">
        <Chip tone={VERDICT_TONE[port.verdict]}>{VERDICT_LABEL[port.verdict]}</Chip>
        {exposed && <Chip tone={RISK_TONE[port.risk.level]}>risque {RISK_LABEL[port.risk.level]}</Chip>}
        {exposed && <Chip tone="muted">ATT&amp;CK {port.risk.attack}</Chip>}
      </div>

      <dl className="mt-2.5 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-1.5">
        <dt className="text-muted">Programme</dt>
        <dd className="min-w-0">
          {port.pid !== null ? (
            <button onClick={() => onOpenProcess(port.pid as number)} className="text-accent hover:underline">
              {port.process ?? "?"} <span className="font-mono text-muted">({port.pid})</span>
            </button>
          ) : (
            <span className="text-muted">inconnu</span>
          )}
        </dd>
        <dt className="text-muted">Pare-feu</dt>
        <dd>{port.reason}</dd>
        {port.rules.length > 0 && (
          <>
            <dt className="text-muted">Règles</dt>
            <dd className="space-y-1">
              {port.rules.map((r, i) => (
                <p key={`${r.name}-${i}`} className="rounded bg-surface-2 px-1.5 py-1">
                  <span style={{ color: r.action === "allow" ? "var(--warn)" : "var(--accent)" }}>{r.action === "allow" ? "Autorise" : "Bloque"}</span> ·{" "}
                  <span className="font-medium">{r.name}</span>
                  <span className="block text-[10px] text-muted">
                    par {r.by} · profils {r.profiles.map((p) => PROFILE_LABEL[p] ?? p).join(", ") || "—"} · depuis {r.remote === "*" ? "toute adresse" : r.remote}
                    {r.interfaces.length > 0 && ` · interface ${r.interfaces.join(", ")}`}
                  </span>
                </p>
              ))}
            </dd>
          </>
        )}
        {exposed && (
          <>
            <dt className="text-muted">Pourquoi</dt>
            <dd>{port.risk.why}</dd>
          </>
        )}
      </dl>

      {exposed && port.risk.advice.length > 0 && (
        <div className="mt-2.5 rounded-lg border border-line p-2.5">
          <p className="eyebrow mb-1">Recommandations</p>
          <ul className="list-disc space-y-0.5 pl-4">
            {port.risk.advice.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {ours ? (
        <div className="mt-2.5 flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/5 p-2.5">
          <span className="min-w-0 flex-1">Bloqué par DeTecTX (règle « {ours.name} »).</span>
          <button
            onClick={() => actions.onUnblock(ours.name)}
            disabled={actions.busy !== null}
            className="shrink-0 rounded-md border border-line px-2.5 py-1 text-muted transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
          >
            {actions.busy === "unblock" ? "Retrait…" : "Débloquer"}
          </button>
        </div>
      ) : (
        exposed &&
        (isDynamic(port.port) ? (
          <p className="mt-2.5 rounded-lg border border-line p-2.5 text-muted">
            Port dynamique : {port.process ?? "ce programme"} en choisit un nouveau à chaque démarrage, un blocage par numéro de port ne tiendrait pas. Fermez
            le programme s&apos;il n&apos;a pas besoin d&apos;être joignable, ou retirez la règle qui l&apos;autorise dans le pare-feu Windows.
          </p>
        ) : (
          <BlockAction key={portKey(port)} port={port} defaultProfiles={defaultProfiles} actions={actions} />
        ))
      )}
    </div>
  );
}

/** Bouton « Bloquer ce port » avec choix des réseaux et confirmation en ligne. */
function BlockAction({ port, defaultProfiles, actions }: { port: PortExposure; defaultProfiles: FirewallProfile[]; actions: FirewallActions }) {
  const [confirming, setConfirming] = useState(false);
  const [everywhere, setEverywhere] = useState(false);
  const profiles = everywhere ? ALL_PROFILES : defaultProfiles;
  const breaksSharing = WINDOWS_SHARING.has(port.port) && profiles.some((p) => p !== "public");
  const strong = port.risk.level === "critical" || port.risk.level === "high";

  if (!confirming) {
    return (
      <button
        onClick={() => setConfirming(true)}
        disabled={actions.busy !== null}
        className={`mt-2.5 w-full rounded-md px-3 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
          strong ? "border border-critical/40 text-critical hover:bg-critical/10" : "border border-line hover:border-accent/50 hover:text-accent"
        }`}
      >
        Bloquer ce port dans le pare-feu
      </button>
    );
  }
  return (
    <div className="mt-2.5 rounded-lg border border-critical/40 bg-critical/5 p-2.5">
      <p className="font-medium">
        Bloquer l&apos;entrant {port.proto.toUpperCase()} {port.port}
      </p>
      <fieldset className="mt-1.5 space-y-1">
        <legend className="sr-only">Réseaux concernés</legend>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" checked={!everywhere} onChange={() => setEverywhere(false)} className="accent-[var(--critical)]" />
          sur le réseau actuel (profil {profilesLabel(defaultProfiles)})
        </label>
        <label className="flex cursor-pointer items-center gap-2">
          <input type="radio" checked={everywhere} onChange={() => setEverywhere(true)} className="accent-[var(--critical)]" />
          sur tous les réseaux
        </label>
      </fieldset>
      {breaksSharing && <p className="mt-1.5 text-warn">⚠ Sur un réseau privé, ce blocage coupe le partage de fichiers et d&apos;imprimantes Windows.</p>}
      <p className="mt-1.5 text-muted">Windows demandera une autorisation administrateur. Aucune règle existante n&apos;est modifiée ; le blocage se retire en un clic.</p>
      <div className="mt-2 flex gap-2">
        <button onClick={() => setConfirming(false)} className="flex-1 rounded-md border border-line px-2 py-1 text-muted transition hover:text-foreground">
          Annuler
        </button>
        <button
          onClick={() => {
            setConfirming(false);
            actions.onBlock([{ proto: port.proto, port: port.port }], profiles);
          }}
          disabled={actions.busy !== null}
          className="flex-1 rounded-md bg-critical px-2 py-1 font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
        >
          {actions.busy === "block" ? "Blocage…" : "Confirmer le blocage"}
        </button>
      </div>
    </div>
  );
}
