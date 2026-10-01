"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  acceptNetworkGateway,
  fetchMe,
  fetchNetworkDevices,
  fetchNetworkStatus,
  resetNetworkBaseline,
  startNetworkScan,
  updateNetworkDevice,
  type NetInventory,
  type NetStatus,
  type ScanProfile,
  type User,
} from "@/lib/api";
import { isPresent, RISK_RANK } from "@/lib/sonar";
import { fmtAgo, fmtClock } from "@/lib/time";
import { usePolling } from "@/lib/use-polling";
import { SonarPanel } from "@/components/network/sonar-panel";
import { DeviceList } from "@/components/network/device-list";
import { DeviceDetail } from "@/components/network/device-detail";

const STATUS_MS = 10_000;
const STATUS_SCANNING_MS = 3_000;
const DEVICES_MS = 15_000;
const PROFILE_LABEL: Record<ScanProfile, string> = { discovery: "Découverte", ports: "Scan des ports", deep: "Analyse approfondie" };

/**
 * Réseau local : les AUTRES appareils de votre réseau (box, téléphones, TV, objets connectés…),
 * vus par la table ARP de Windows en continu et par Nmap quand le réseau est privé.
 * À ne pas confondre avec Système > Connexions (à qui parle CE poste).
 */
export default function NetworkPage() {
  const [status, setStatus] = useState<NetStatus | null>(null);
  const [inv, setInv] = useState<NetInventory | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const wasRunning = useRef(false);

  const loadDevices = useCallback(async () => {
    try {
      setInv(await fetchNetworkDevices());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Réseau local indisponible");
    }
  }, []);
  const loadStatus = useCallback(async () => {
    const s = await fetchNetworkStatus().catch(() => null);
    if (!s) return;
    setStatus(s);
    // Fin d'un scan : l'inventaire a changé (nouveaux appareils, ports).
    if (wasRunning.current && !s.running) {
      void loadDevices();
      setNotice(s.error ? `Scan interrompu : ${s.error}` : "Scan terminé.");
    }
    wasRunning.current = s.running !== null;
  }, [loadDevices]);
  usePolling(loadStatus, status?.running ? STATUS_SCANNING_MS : STATUS_MS);
  usePolling(loadDevices, DEVICES_MS);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((u) => !cancelled && setUser(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

  const canAct = user?.role === "admin" || user?.role === "analyst";
  const isAdmin = user?.role === "admin";
  const devices = inv?.devices ?? [];
  // Fiche affichée : celle choisie, sinon ce qui demande une action (l'API trie dans cet ordre).
  const current = devices.find((d) => d.id === selected) ?? devices.find((d) => d.gateway_mismatch || d.status === "new") ?? devices[0] ?? null;
  const blocked = status?.active_blocked ?? null;
  const scanning = status?.running != null;

  async function act(fn: () => Promise<unknown>, done: string, reload: "devices" | "status" = "devices") {
    setBusy(true);
    try {
      await fn();
      setNotice(done);
      await (reload === "devices" ? loadDevices() : loadStatus());
    } catch (e) {
      setNotice(e instanceof Error ? e.message : "Action impossible");
    } finally {
      setBusy(false);
    }
  }
  const scan = (profile: ScanProfile, deviceId?: string) =>
    void act(() => startNetworkScan(profile, deviceId), `${PROFILE_LABEL[profile]} lancée : résultats dans un instant.`, "status");

  const present = devices.filter((d) => isPresent(d, now)).length;
  const todo = devices.filter((d) => d.gateway_mismatch || d.status === "new").length;
  const exposedCount = devices.filter((d) => RISK_RANK[d.risk] >= RISK_RANK.high).length;
  const spoofed = devices.some((d) => d.gateway_mismatch);
  const net = status?.network;
  const learningUntil = inv?.network?.learning_until ? new Date(inv.network.learning_until).getTime() : 0;
  const learning = learningUntil > now;
  const isPublic = net?.categories.includes("public") ?? false;

  const message =
    error ??
    notice ??
    (spoofed
      ? "Un appareil répond à la place de votre box : ouvrez sa fiche."
      : blocked ?? (learning ? `Apprentissage jusqu'à ${fmtClock(learningUntil)} : les appareils qui apparaissent rejoignent la référence sans alerte (la box reste surveillée).` : "Les appareils de votre réseau, ceux qui viennent d'arriver, et ce qu'ils exposent."));

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 lg:flex-nowrap">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold">Réseau local</h1>
            {net && (
              <span className="rounded-lg border border-line px-2 py-0.5 text-xs text-muted">
                {net.name} · <span className="font-mono">{net.subnet}</span>
              </span>
            )}
            {net && (
              <span className={`rounded-lg px-2 py-0.5 text-xs ${isPublic ? "bg-warn/15 text-warn" : "bg-accent/15 text-accent"}`} title={isPublic ? "Windows classe ce réseau en Public : scans actifs désactivés" : "Réseau privé : scans actifs autorisés"}>
                {isPublic ? "réseau public" : "réseau privé"}
              </span>
            )}
            {status && !status.online && <span className="rounded-lg bg-critical/15 px-2 py-0.5 text-xs text-critical">hors ligne</span>}
          </div>
          <p className={`truncate text-sm ${spoofed && !error && !notice ? "text-critical" : "text-muted"}`} title={message}>
            {message}
          </p>
        </div>
        <div className="hidden shrink-0 gap-2 xl:flex">
          <Kpi label="Appareils" value={devices.length} sub={`${present} présent${present > 1 ? "s" : ""}`} tone="foreground" />
          <Kpi label="À vérifier" value={todo} sub={todo ? "nouveaux ou suspects" : "rien de neuf"} tone={spoofed ? "critical" : todo ? "warn" : "accent"} />
          <Kpi label="Exposés" value={exposedCount} sub="service à risque" tone={exposedCount ? "warn" : "accent"} />
          <Kpi label="Découverte" value={status?.last_discovery ? fmtAgo(status.last_discovery, now) : "—"} sub={blocked ? "mode passif" : `toutes les ${status?.schedule.discovery_min ?? 15} min`} tone="foreground" />
        </div>
      </div>

      {canAct && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button onClick={() => scan("discovery")} disabled={busy || scanning || blocked !== null} title={blocked ?? "Qui est sur le réseau (≈ 3 s)"} className="rounded-lg bg-accent px-3 py-1.5 font-medium text-accent-fg transition disabled:cursor-not-allowed disabled:opacity-40">
            Découvrir les appareils
          </button>
          <button onClick={() => scan("ports")} disabled={busy || scanning || blocked !== null} title={blocked ?? "Les 100 ports les plus courants de chaque appareil (≈ 15 s)"} className="rounded-lg border border-line px-3 py-1.5 transition hover:border-accent/50 disabled:cursor-not-allowed disabled:opacity-40">
            Scanner les ports
          </button>
          {scanning && status?.running && (
            <span className="animate-pulse text-accent">
              {PROFILE_LABEL[status.running.profile]} en cours sur <span className="font-mono">{status.running.target}</span>…
            </span>
          )}
          {!status?.nmap_installed && status && <span className="text-muted">Nmap non installé : seule la couche passive (table ARP) tourne. Installez Nmap avec Npcap depuis nmap.org.</span>}
          {isAdmin && (
            <span className="ml-auto flex items-center gap-2">
              {confirmReset ? (
                <>
                  <span className="text-muted">Tout réapprendre (24 h d&apos;apprentissage) ?</span>
                  <button
                    onClick={() => {
                      setConfirmReset(false);
                      void act(resetNetworkBaseline, "Nouvelle référence : le réseau est en cours de réapprentissage.");
                    }}
                    disabled={busy}
                    className="rounded-lg bg-warn px-2.5 py-1 font-medium text-black disabled:opacity-40"
                  >
                    Confirmer
                  </button>
                  <button onClick={() => setConfirmReset(false)} className="text-muted hover:text-foreground">Annuler</button>
                </>
              ) : (
                <button onClick={() => setConfirmReset(true)} className="text-muted hover:text-foreground">
                  Nouvelle référence…
                </button>
              )}
            </span>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:h-[calc(100dvh-15rem)] lg:min-h-[480px] lg:grid-cols-12 lg:grid-rows-2">
        {inv ? (
          <>
            <SonarPanel devices={devices} now={now} selected={current?.id ?? null} scanning={scanning} onSelect={setSelected} className="h-[28rem] lg:col-span-5 lg:row-span-2 lg:h-auto" />
            <DeviceList devices={devices} now={now} selected={current?.id ?? null} onSelect={setSelected} className="h-[28rem] lg:col-span-4 lg:row-span-2 lg:h-auto" />
            <DeviceDetail
              key={current?.id ?? "none"}
              device={current}
              now={now}
              canAct={canAct}
              isAdmin={isAdmin}
              blocked={blocked}
              scanning={scanning}
              busy={busy}
              onRename={(label) => current && void act(() => updateNetworkDevice(current.id, { label }), label ? `Renommé « ${label} ».` : "Nom effacé.")}
              onApprove={() => current && void act(() => updateNetworkDevice(current.id, { approve: true }), "Appareil approuvé : il rejoint le cercle de confiance.")}
              onDeepScan={() => current && scan("deep", current.id)}
              onAcceptGateway={() => current && void act(() => acceptNetworkGateway(current.id), "Nouvelle box acceptée comme référence.")}
              className="h-[32rem] lg:col-span-3 lg:row-span-2 lg:h-auto"
            />
          </>
        ) : (
          <div className="panel flex items-center justify-center p-8 text-sm text-muted lg:col-span-12 lg:row-span-2">{error ?? "Lecture du réseau local…"}</div>
        )}
      </div>
    </>
  );
}

function Kpi({ label, value, sub, tone }: { label: string; value: number | string; sub: string; tone: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface px-3 py-1.5">
      <p className="text-[10px] uppercase tracking-wide text-muted">{label}</p>
      <p className="flex items-baseline gap-1.5 font-mono text-sm font-semibold tabular-nums leading-tight" style={{ color: `var(--${tone})` }}>
        {value}
        <span className="font-sans text-[10px] font-normal text-muted">{sub}</span>
      </p>
    </div>
  );
}
