"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  blockPorts,
  closeProcess,
  fetchConnections,
  fetchExposure,
  fetchMetrics,
  fetchProcesses,
  killProcess,
  type Metrics,
  type ExposureSnapshot,
  type FirewallProfile,
  type NetSnapshot,
  type ProcInfo,
  unblockRule,
} from "@/lib/api";
import { diffExposure, diffNetwork, diffProcesses, pushEvents, type ActivityEvent } from "@/lib/activity";
import { fmtBytes, fmtUptime } from "@/lib/host";
import { aggregateNodes, aggregatePorts } from "@/lib/netmap";
import { buildTree, hintsFor } from "@/lib/proctree";
import { buildApps, exeKey, type AppGroup } from "@/lib/apps";
import { CpuPanel, RamPanel, StoragePanel } from "@/components/system/hardware-panels";
import { CityPanel } from "@/components/system/city-panel";
import { ProcessPanel } from "@/components/system/process-panel";
import { SelectionCard, type Notice, type ProcAction, type ProcActions } from "@/components/system/process-details";
import { AppsPanel } from "@/components/system/apps-panel";
import { LineagePanel } from "@/components/system/lineage-panel";
import { ActivityFeed } from "@/components/system/activity-feed";
import { ConnectionsPanel, NetworkMapPanel } from "@/components/system/network-panels";
import { PortsPanel, RampartPanel, type FirewallActions } from "@/components/system/ports-panels";

const METRICS_MS = 2000;
const PROCESSES_MS = 3000; // instantané natif (~15 ms côté backend)
const NETWORK_MS = 5000;
const EXPOSURE_MS = 15000; // règles du pare-feu mises en cache 15 s côté backend
const CITY_SIZE = 60; // = MAX_BUILDINGS de la ville 3D

const VIEWS = [
  { key: "ressources", label: "Ressources" },
  { key: "reseau", label: "Réseau" },
  { key: "processus", label: "Processus & activité" },
  { key: "ports", label: "Ports & pare-feu" },
] as const;
type View = (typeof VIEWS)[number]["key"];

// Desktop : tout tient dans l'écran (même calcul que l'Overview) ; seules les listes défilent.
const GRID = "grid gap-4 lg:h-[calc(100dvh-13.75rem)] lg:min-h-[520px] lg:grid-cols-12";

/**
 * Exécute `task` tout de suite puis à intervalle, en sautant les tours où l'onglet est caché ;
 * rafraîchit immédiatement au retour sur l'onglet (pas de données périmées pendant `ms`).
 * Jamais deux requêtes simultanées : un tour est sauté tant que le précédent n'a pas répondu.
 */
function usePolling(task: () => Promise<void>, ms: number) {
  useEffect(() => {
    let inFlight = false;
    const run = () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      void task().finally(() => {
        inFlight = false;
      });
    };
    const first = window.setTimeout(run, 0);
    const id = window.setInterval(run, ms);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", run);
    };
  }, [task, ms]);
}

export default function MachinesPage() {
  return (
    <Suspense fallback={null}>
      <MachinesView />
    </Suspense>
  );
}

/** Page Système — « salle des machines » : ressources, réseau et processus du poste, sans défilement. */
function MachinesView() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const view: View = VIEWS.some((v) => v.key === params.get("vue")) ? (params.get("vue") as View) : "ressources";

  const [m, setM] = useState<Metrics | null>(null);
  const [procs, setProcs] = useState<ProcInfo[] | null>(null);
  const [net, setNet] = useState<NetSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [selectedIp, setSelectedIp] = useState<string | null>(null);
  const [exposure, setExposure] = useState<ExposureSnapshot | null>(null);
  const [selectedPort, setSelectedPort] = useState<string | null>(null);
  const [fwBusy, setFwBusy] = useState<FirewallActions["busy"]>(null);
  const [fwNotice, setFwNotice] = useState<FirewallActions["notice"]>(null);
  const [highlightIp, setHighlightIp] = useState<string | null>(null);
  const [busy, setBusy] = useState<ProcAction | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [since, setSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Instantanés précédents : base des différences du journal d'activité.
  const prevProcs = useRef<ProcInfo[] | null>(null);
  const prevNet = useRef<NetSnapshot | null>(null);
  const prevExposure = useRef<ExposureSnapshot | null>(null);

  const loadMetrics = useCallback(async () => {
    try {
      setM(await fetchMetrics());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Métriques indisponibles");
    }
  }, []);

  const loadProcs = useCallback(async () => {
    try {
      const next = await fetchProcesses(2000);
      const at = Date.now();
      const prev = prevProcs.current;
      prevProcs.current = next;
      if (prev) {
        const tree = buildTree(next);
        const flagged = (p: ProcInfo) => {
          const node = tree.byPid.get(p.pid);
          return node ? hintsFor(node).length > 0 : false;
        };
        setEvents((log) => pushEvents(log, diffProcesses(prev, next, at, flagged)));
      } else {
        setSince(at);
      }
      setProcs(next);
      setNow(at);
    } catch {
      // Liste conservée : une erreur ponctuelle ne doit pas vider les vues.
      setProcs((p) => p ?? []);
    }
  }, []);

  const loadNet = useCallback(async () => {
    try {
      const next = await fetchConnections();
      const prev = prevNet.current;
      prevNet.current = next;
      if (prev) setEvents((log) => pushEvents(log, diffNetwork(prev, next, Date.now())));
      setNet(next);
    } catch {
      // Réseau indisponible : la vue garde le dernier relevé.
    }
  }, []);

  const loadExposure = useCallback(async () => {
    try {
      const next = await fetchExposure();
      const prev = prevExposure.current;
      prevExposure.current = next;
      if (prev) setEvents((log) => pushEvents(log, diffExposure(prev, next, Date.now())));
      setExposure(next);
    } catch {
      // Exposition indisponible : la vue garde le dernier relevé.
    }
  }, []);

  usePolling(loadMetrics, METRICS_MS);
  usePolling(loadProcs, PROCESSES_MS);
  usePolling(loadNet, NETWORK_MS);
  usePolling(loadExposure, EXPOSURE_MS);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSelected(null);
      setSelectedIp(null);
      setSelectedPort(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const tree = useMemo(() => (procs ? buildTree(procs) : null), [procs]);
  const top = useMemo(() => procs?.slice(0, CITY_SIZE) ?? null, [procs]);
  const nodes = useMemo(() => aggregateNodes(net), [net]);
  const ports = useMemo(() => aggregatePorts(net), [net]);
  const cpuCount = m?.cpu_count ?? 1;
  const selectedNode = selected === null ? null : (tree?.byPid.get(selected) ?? null);
  const apps = useMemo(() => (tree ? buildApps(tree) : []), [tree]);
  // Vue Processus : sans sélection, on montre l'application ouverte la plus lourde.
  const defaultApp = useMemo(
    () => apps.filter((a) => a.category === "window").sort((a, b) => b.rss - a.rss)[0] ?? apps[0] ?? null,
    [apps],
  );
  const focusNode = selectedNode ?? (defaultApp ? (defaultApp.windowOwner ?? defaultApp.primary) : null);
  const focusApp: AppGroup | null = focusNode ? (apps.find((a) => a.key === exeKey(focusNode.proc)) ?? null) : null;

  const setView = (next: View) => router.replace(`${pathname}?vue=${next}`, { scroll: false });
  const onSelect = useCallback((pid: number | null) => {
    setSelected(pid);
    setNotice(null);
  }, []);
  const openProcess = (pid: number) => {
    onSelect(pid);
    setView("processus");
  };

  async function runAction(action: ProcAction, p: ProcInfo, work: () => Promise<Notice>) {
    setBusy(action);
    setNotice(null);
    try {
      const result = await work();
      await loadProcs();
      setNotice(result);
    } catch (e) {
      setNotice({ tone: "critical", text: e instanceof Error ? e.message : "Action impossible." });
    } finally {
      setBusy(null);
    }
  }

  const actions: ProcActions = {
    busy,
    notice,
    onClose: (p) =>
      void runAction("close", p, async () => {
        const label = p.name ?? `PID ${p.pid}`;
        const r = await closeProcess(p.pid);
        if (r.exited) {
          setSelected(null);
          return { tone: "ok", text: `« ${label} » s'est fermé normalement.` };
        }
        return {
          tone: "warn",
          text: `Fermeture demandée à ${r.windows} fenêtre${r.windows > 1 ? "s" : ""} : « ${label} » attend sans doute une réponse sur le bureau (enregistrer ?).`,
        };
      }),
    onKill: (p, withTree) =>
      void runAction("kill", p, async () => {
        const label = p.name ?? `PID ${p.pid}`;
        const r = await killProcess(p.pid, { tree: withTree });
        setSelected(null);
        const extra = r.tree.length - 1;
        const failed = r.failed.length > 0 ? ` ${r.failed.length} sous-processus n'ont pas pu être arrêtés (accès refusé).` : "";
        return { tone: failed ? "warn" : "ok", text: `« ${label} » arrêté${extra > 0 ? ` avec ${extra} sous-processus` : ""}.${failed}` };
      }),
  };

  // Pare-feu : chaque action passe par l'invite UAC de Windows ; on relit l'exposition ensuite.
  async function runFirewall(kind: "block" | "unblock", work: () => Promise<string>) {
    setFwBusy(kind);
    setFwNotice(null);
    try {
      const text = await work();
      setFwNotice({ tone: "ok", text });
    } catch (e) {
      setFwNotice({ tone: "critical", text: e instanceof Error ? e.message : "Modification du pare-feu impossible." });
    } finally {
      setFwBusy(null);
      await loadExposure();
    }
  }

  const firewallActions: FirewallActions = {
    busy: fwBusy,
    notice: fwNotice,
    onBlock: (targets, profiles: FirewallProfile[]) =>
      void runFirewall("block", async () => {
        const r = await blockPorts(targets, profiles);
        return `${r.rules.length} blocage(s) ajouté(s) au pare-feu Windows : ${targets.map((t) => `${t.proto.toUpperCase()} ${t.port}`).join(", ")}.`;
      }),
    onUnblock: (name) =>
      void runFirewall("unblock", async () => {
        await unblockRule(name);
        return `Blocage retiré : « ${name} ».`;
      }),
  };

  const established = net?.connections.filter((c) => c.status === "ESTABLISHED").length;
  // « Joignables » = liés au réseau ET autorisés par le pare-feu (et non simplement liés à 0.0.0.0).
  const reachable = exposure ? exposure.summary.open : null;

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="relative flex h-2 w-2 shrink-0">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
            </span>
            <h1 className="text-lg font-semibold">
              Salle des machines <span className="font-mono text-base font-normal text-muted">· {m?.hostname ?? "—"}</span>
            </h1>
          </div>
          <div className="mt-1.5 flex gap-1" role="tablist" aria-label="Vues du système">
            {VIEWS.map((v) => (
              <button
                key={v.key}
                role="tab"
                aria-selected={view === v.key}
                onClick={() => setView(v.key)}
                className={`rounded-lg px-3 py-1 text-sm transition ${view === v.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
              >
                {v.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
          <Stat label="Uptime" value={m ? fmtUptime(m.uptime_seconds) : "—"} />
          <Stat label="Processus" value={m?.process_count ?? "—"} />
          <Stat label="Connexions" value={established ?? "—"} />
          <Stat label="Ports joignables" value={reachable ?? "—"} tone={reachable ? "warn" : undefined} />
          <Stat label="Réseau" value={m ? `↓ ${fmtBytes(m.net_down)}/s · ↑ ${fmtBytes(m.net_up)}/s` : "—"} />
        </div>
      </div>

      {error && <p className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>}

      {view === "ressources" && (
        <div className={`${GRID} lg:grid-rows-[minmax(0,1fr)_minmax(0,1.35fr)]`}>
          <CpuPanel metrics={m} className="h-64 lg:col-span-4 lg:h-auto" />
          <RamPanel metrics={m} className="h-64 lg:col-span-4 lg:h-auto" />
          <StoragePanel metrics={m} className="h-64 lg:col-span-4 lg:h-auto" />
          <CityPanel
            processes={top ?? []}
            cpuCount={cpuCount}
            selected={selected}
            highlight={highlight}
            onHighlight={setHighlight}
            onSelect={onSelect}
            className="h-80 lg:col-span-8 lg:h-auto"
          />
          <ProcessPanel
            processes={top}
            tree={tree}
            cpuCount={cpuCount}
            selected={selected}
            highlight={highlight}
            onHighlight={setHighlight}
            onSelect={onSelect}
            actions={actions}
            now={now}
            className="h-[28rem] lg:col-span-4 lg:h-auto"
          />
        </div>
      )}

      {view === "ports" && (
        <div className={GRID}>
          <RampartPanel snapshot={exposure} selected={selectedPort} onSelect={setSelectedPort} className="h-96 lg:col-span-8 lg:h-auto" />
          <PortsPanel
            snapshot={exposure}
            selected={selectedPort}
            onSelect={setSelectedPort}
            onOpenProcess={openProcess}
            actions={firewallActions}
            className="h-[32rem] lg:col-span-4 lg:h-auto"
          />
        </div>
      )}

      {view === "reseau" && (
        <div className={GRID}>
          <NetworkMapPanel
            nodes={nodes}
            ports={ports}
            snapshot={net}
            selected={selectedIp}
            highlight={highlightIp}
            throughput={(m?.net_up ?? 0) + (m?.net_down ?? 0)}
            onHighlight={setHighlightIp}
            onSelect={setSelectedIp}
            className="h-96 lg:col-span-8 lg:h-auto"
          />
          <ConnectionsPanel
            snapshot={net}
            nodes={nodes}
            ports={ports}
            selected={selectedIp}
            highlight={highlightIp}
            onHighlight={setHighlightIp}
            onSelect={setSelectedIp}
            onOpenProcess={openProcess}
            className="h-[28rem] lg:col-span-4 lg:h-auto"
          />
        </div>
      )}

      {view === "processus" && (
        <div className={`${GRID} lg:grid-rows-[minmax(0,1.3fr)_minmax(0,1fr)]`}>
          <AppsPanel
            apps={apps}
            cpuCount={cpuCount}
            current={focusApp?.key ?? null}
            onPick={(app) => onSelect((app.windowOwner ?? app.primary).proc.pid)}
            className="h-[28rem] lg:col-span-4 lg:row-span-2 lg:h-auto"
          />
          <LineagePanel app={focusApp} focus={focusNode} cpuCount={cpuCount} onSelect={onSelect} className="h-80 lg:col-span-8 lg:h-auto" />
          <div className="panel flex min-h-0 flex-col overflow-hidden lg:col-span-4">
            <div className="border-b border-line px-4 py-2.5">
              <span className="eyebrow">Processus sélectionné</span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <SelectionCard
                selected={focusNode?.proc.pid ?? selected}
                node={focusNode}
                cpuCount={cpuCount}
                now={now}
                actions={actions}
                onSelect={onSelect}
                emptyHint="Choisissez une application ou un nœud de la lignée."
              />
            </div>
          </div>
          <ActivityFeed
            events={events}
            since={since}
            now={now}
            alive={(pid) => tree?.byPid.has(pid) ?? false}
            onSelect={onSelect}
            className="h-80 lg:col-span-4 lg:h-auto"
          />
        </div>
      )}
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono tabular-nums" style={tone ? { color: `var(--${tone})` } : undefined}>
        {value}
      </span>
    </span>
  );
}
