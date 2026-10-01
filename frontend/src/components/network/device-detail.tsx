"use client";

import { useState } from "react";
import type { NetDevice } from "@/lib/api";
import { displayName, isPresent, RISK_LABEL, RISK_TONE, STATUS_LABEL, STATUS_TONE } from "@/lib/sonar";
import { fmtAgo } from "@/lib/time";
import { fmtDate } from "@/lib/intel";

interface DeviceDetailProps {
  device: NetDevice | null;
  now: number;
  canAct: boolean;
  isAdmin: boolean;
  /** Raison pour laquelle les scans actifs sont refusés, sinon null. */
  blocked: string | null;
  scanning: boolean;
  busy: boolean;
  onRename: (label: string | null) => void;
  onApprove: () => void;
  onDeepScan: () => void;
  onAcceptGateway: () => void;
  className?: string;
}

/** Fiche d'un appareil : ce qu'on sait (et d'où), pourquoi il demande une action, quoi faire. */
export function DeviceDetail({ device: d, now, canAct, isAdmin, blocked, scanning, busy, onRename, onApprove, onDeepScan, onAcceptGateway, className = "" }: DeviceDetailProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [confirmGateway, setConfirmGateway] = useState(false);

  if (!d) {
    return <div className={`panel grid place-items-center p-6 text-center text-sm text-muted ${className}`}>Choisissez un appareil sur le Sonar ou dans la liste.</div>;
  }
  const present = isPresent(d, now);
  const openPorts = d.ports.filter((p) => p.open);
  const closedPorts = d.ports.filter((p) => !p.open);
  const scanDisabled = !canAct || busy || scanning || blocked !== null;

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="border-b border-line px-4 py-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            {editing ? (
              <form
                className="flex gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  onRename(draft.trim() || null);
                  setEditing(false);
                }}
              >
                <input
                  autoFocus
                  value={draft}
                  maxLength={80}
                  onChange={(e) => setDraft(e.target.value)}
                  placeholder={d.hostname?.split(".")[0] ?? "Nom de l'appareil"}
                  aria-label="Nom de l'appareil"
                  className="min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent/60"
                />
                <button type="submit" className="rounded-md bg-accent px-2 text-xs text-accent-fg">OK</button>
                <button type="button" onClick={() => setEditing(false)} className="rounded-md px-2 text-xs text-muted hover:text-foreground">Annuler</button>
              </form>
            ) : (
              <p className="flex items-center gap-2 truncate text-base font-semibold">
                {displayName(d)}
                {canAct && (
                  <button
                    onClick={() => {
                      setDraft(d.label ?? "");
                      setEditing(true);
                    }}
                    className="text-[11px] font-normal text-accent hover:underline"
                  >
                    renommer
                  </button>
                )}
              </p>
            )}
            <p className="text-xs text-muted">
              {d.kind_label}
              {d.is_gateway ? " · box de référence" : ""} · {present ? "présent" : `absent, vu ${fmtAgo(d.last_seen, now)}`}
            </p>
          </div>
          {d.gateway_mismatch ? (
            <span className="shrink-0 rounded bg-critical/15 px-2 py-0.5 text-[11px] font-medium text-critical">À traiter</span>
          ) : (
            <span className="shrink-0 rounded px-2 py-0.5 text-[11px]" style={{ color: `var(--${STATUS_TONE[d.status]})`, backgroundColor: `color-mix(in srgb, var(--${STATUS_TONE[d.status]}) 14%, transparent)` }}>
              {STATUS_LABEL[d.status]}
            </span>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-xs">
        {d.gateway_mismatch && (
          <section className="rounded-lg border border-critical/40 bg-critical/10 p-3">
            <p className="font-semibold text-critical">Cet appareil répond à la place de votre box</p>
            <p className="mt-1 leading-relaxed">
              L&apos;adresse de la passerelle ({d.ip}) répond avec la MAC <span className="font-mono">{d.mac}</span>, qui n&apos;est pas celle de votre box de référence. C&apos;est la signature d&apos;une attaque de l&apos;homme du milieu
              (empoisonnement ARP, MITRE T1557.002) : votre trafic peut être intercepté.
            </p>
            <ol className="mt-2 list-decimal space-y-0.5 pl-4">
              <li>Déconnectez ce PC du réseau.</li>
              <li>Comparez avec l&apos;adresse MAC inscrite sous la box.</li>
              <li>N&apos;acceptez cette MAC que si la box a réellement été remplacée.</li>
            </ol>
            <p className="mt-2 text-muted">Source : table ARP de Windows, relue chaque minute.</p>
            {isAdmin &&
              (confirmGateway ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button onClick={onAcceptGateway} disabled={busy} className="rounded-md bg-critical px-2.5 py-1 text-[11px] font-medium text-white disabled:opacity-50">
                    Oui, c&apos;est ma nouvelle box
                  </button>
                  <button onClick={() => setConfirmGateway(false)} className="rounded-md px-2.5 py-1 text-[11px] text-muted hover:text-foreground">Annuler</button>
                </div>
              ) : (
                <button onClick={() => setConfirmGateway(true)} className="mt-2 text-[11px] text-critical underline-offset-2 hover:underline">
                  La box a été remplacée…
                </button>
              ))}
          </section>
        )}
        {!d.gateway_mismatch && d.status === "new" && (
          <section className="rounded-lg border border-warn/40 bg-warn/10 p-3">
            <p className="font-semibold text-warn">Nouvel appareil sur votre réseau</p>
            <p className="mt-1 leading-relaxed">
              Jamais vu avant le {fmtDate(d.first_seen)}.{d.randomized_mac ? " Son adresse MAC est privée : c'est souvent un téléphone ou une tablette." : ""} Si vous ne le reconnaissez pas, changez le mot de passe du Wi-Fi.
            </p>
            {canAct && (
              <button onClick={onApprove} disabled={busy} className="mt-2 rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-accent-fg disabled:opacity-50">
                Je le reconnais : approuver
              </button>
            )}
          </section>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5">
          <dt className="text-muted">Adresse IP</dt>
          <dd className="font-mono">{d.ip}</dd>
          <dt className="text-muted">Adresse MAC</dt>
          <dd className="font-mono">
            {d.mac}
            {d.randomized_mac && <span className="ml-1 font-sans text-muted">(privée)</span>}
          </dd>
          <dt className="text-muted">Fabricant</dt>
          <dd>{d.vendor ?? <span className="text-muted">inconnu{d.randomized_mac ? " (MAC privée)" : ""}</span>}</dd>
          <dt className="text-muted">Nom annoncé</dt>
          <dd className="truncate">{d.hostname ?? <span className="text-muted">aucun</span>}</dd>
          <dt className="text-muted">Système</dt>
          <dd>{d.os_guess ? <span title="Deviné par Nmap : indice, pas une certitude">{d.os_guess} <span className="text-muted">(indice)</span></span> : <span className="text-muted">analyse approfondie nécessaire</span>}</dd>
          <dt className="text-muted">Vu depuis</dt>
          <dd>{fmtDate(d.first_seen)}</dd>
          <dt className="text-muted">Ports</dt>
          <dd>{d.ports_scanned_at ? `scannés ${fmtAgo(d.ports_scanned_at, now)}` : <span className="text-muted">jamais scannés</span>}</dd>
        </dl>

        <section>
          <div className="mb-1.5 flex items-center justify-between">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-muted">
              Services exposés <span style={{ color: `var(--${RISK_TONE[d.risk]})` }}>· {RISK_LABEL[d.risk].toLowerCase()}</span>
            </p>
            {canAct && (
              <button onClick={onDeepScan} disabled={scanDisabled} title={blocked ?? (scanning ? "Un scan est déjà en cours" : "Services, versions et système (1 000 ports, ~1 min)")} className="text-[11px] text-accent hover:underline disabled:cursor-not-allowed disabled:text-muted disabled:no-underline">
                Analyser en profondeur
              </button>
            )}
          </div>
          {openPorts.length === 0 ? (
            <p className="text-muted">{d.ports_scanned_at ? "Aucun port ouvert parmi ceux examinés." : blocked ? "Pas encore scanné : les scans actifs sont désactivés sur ce réseau." : "Pas encore scanné."}</p>
          ) : (
            <ul className="space-y-1.5">
              {openPorts.map((p) => (
                <li key={`${p.proto}/${p.port}`} className="rounded-lg border border-line p-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[11px]">
                      {p.proto.toUpperCase()} {p.port}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-medium">
                      {p.service}
                      {p.product ? <span className="font-normal text-muted"> · {[p.product, p.version].filter(Boolean).join(" ")}</span> : null}
                    </span>
                    {p.status === "new" && <span className="rounded bg-warn/15 px-1 text-[10px] text-warn">nouveau</span>}
                    <span className="text-[10px]" style={{ color: `var(--${RISK_TONE[p.risk.level]})` }}>
                      {RISK_LABEL[p.risk.level]}
                    </span>
                  </div>
                  <p className="mt-1 leading-snug text-muted">
                    {p.risk.why} <span className="font-mono">{p.risk.attack}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {closedPorts.length > 0 && <p className="mt-1.5 text-muted">Refermés depuis : {closedPorts.map((p) => `${p.proto.toUpperCase()} ${p.port}`).join(", ")}.</p>}
        </section>
      </div>
    </div>
  );
}
