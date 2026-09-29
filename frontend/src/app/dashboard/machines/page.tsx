"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  blockPorts,
  closeProcess,
  fetchConnections,
  fetchExposure,
  fetchHardening,
  fetchMe,
  fetchMetrics,
  fetchPersistence,
  fetchProcesses,
  fetchRemedies,
  killProcess,
  type Metrics,
  type ExposureSnapshot,
  type FirewallProfile,
  type HardeningSnapshot,
  type NetSnapshot,
  type PersistenceEntry,
  type PersistenceSnapshot,
  type ProcInfo,
  type RemedyRecord,
  type User,
  unblockRule,
} from "@/lib/api";
import { diffExposure, diffNetwork, diffPersistence, diffProcesses, pushEvents, type ActivityEvent } from "@/lib/activity";
import { GRADE_TONE } from "@/lib/hardening";
import { trust } from "@/lib/persistence";
import { fmtBytes, fmtUptime } from "@/lib/host";
import { aggregateNodes, aggregatePorts } from "@/lib/netmap";
import { buildTree, hintsFor } from "@/lib/proctree";
import { usePolling } from "@/lib/use-polling";
import { buildApps, exeKey, type AppGroup } from "@/lib/apps";
import { CpuPanel, RamPanel, StoragePanel } from "@/components/system/hardware-panels";
import { CityPanel } from "@/components/system/city-panel";
import { ProcessPanel } from "@/components/system/process-panel";
import { SelectionCard, StartupLookup, type Notice, type ProcAction, type ProcActions } from "@/components/system/process-details";
import { AppsPanel } from "@/components/system/apps-panel";
import { LineagePanel } from "@/components/system/lineage-panel";
import { ActivityFeed } from "@/components/system/activity-feed";
import { ConnectionsPanel, NetworkMapPanel } from "@/components/system/network-panels";
import { PortsPanel, RampartPanel, type FirewallActions } from "@/components/system/ports-panels";
import { PersistenceView } from "@/components/system/persistence-view";
import { HardeningView } from "@/components/system/hardening-view";

const METRICS_MS = 2000;
const PROCESSES_MS = 3000; // instantané natif (~15 ms côté backend)
const NETWORK_MS = 5000;
const EXPOSURE_MS = 15000; // règles du pare-feu mises en cache 15 s côté backend
const PERSISTENCE_MS = 60000; // inventaire mis en cache 60 s côté backend (balayage ~2 s)
const HARDENING_MS = 120000;
const CITY_SIZE = 60; // = MAX_BUILDINGS de la ville 3D

const VIEWS = [
  { key: "ressources", label: "Ressources" },
  { key: "reseau", label: "Réseau" },
  { key: "processus", label: "Processus & activité" },
  { key: "ports", label: "Ports & pare-feu" },
  { key: "persistance", label: "Persistance" },
  { key: "durcissement", label: "Durcissement" },
] as const;
type View = (typeof VIEWS)[number]["key"];

// Desktop : tout tient dans l'écran (même calcul que l'Overview) ; seules les listes défilent.
const GRID = "grid gap-4 lg:h-[calc(100dvh-13.75rem)] lg:min-h-[520px] lg:grid-cols-12";

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
  const prevPersist = useRef<PersistenceSnapshot | null>(null);
  const [persist, setPersist] = useState<PersistenceSnapshot | null>(null);
  const [persistError, setPersistError] = useState<string | null>(null);
  const [persistSelected, setPersistSelected] = useState<string | null>(null);
  const [hard, setHard] = useState<HardeningSnapshot | null>(null);
  const [hardError, setHardError] = useState<string | null>(null);
  const [remedyLog, setRemedyLog] = useState<RemedyRecord[]>([]);
  const [user, setUser] = useState<User | null>(null);

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

  const loadPersistence = useCallback(async () => {
    try {
      const next = await fetchPersistence();
      const prev = prevPersist.current;
      prevPersist.current = next;
      if (prev) setEvents((log) => pushEvents(log, diffPersistence(prev, next, Date.now())));
      setPersist(next);
      setPersistError(null);
    } catch (e) {
      setPersistError(e instanceof Error ? e.message : "Inventaire de persistance indisponible");
    }
  }, []);

  const loadHardening = useCallback(async () => {
    try {
      const [h, r] = await Promise.all([fetchHardening(), fetchRemedies()]);
      setHard(h);
      setRemedyLog(r.history);
      setHardError(null);
    } catch (e) {
      setHardError(e instanceof Error ? e.message : "Durcissement illisible");
    }
  }, []);

  usePolling(loadMetrics, METRICS_MS);
  usePolling(loadPersistence, PERSISTENCE_MS);
  usePolling(loadHardening, HARDENING_MS);
  usePolling(loadProcs, PROCESSES_MS);
  usePolling(loadNet, NETWORK_MS);
  usePolling(loadExposure, EXPOSURE_MS);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((u) => !cancelled && setUser(u))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  // Exécutable -> PID (fiche de persistance : « en cours d'exécution ») et exécutable -> entrée de
  // persistance (fiche processus : « se relance au démarrage »). Chemins comparés sans la casse.
  const pidByExe = useMemo(() => {
    const map = new Map<string, number>();
    procs?.forEach((p) => {
      if (p.exe && !map.has(p.exe.toLowerCase())) map.set(p.exe.toLowerCase(), p.pid);
    });
    return map;
  }, [procs]);
  const entryByExe = useMemo(() => {
    const map = new Map<string, PersistenceEntry>();
    persist?.entries.forEach((e) => {
      if (e.mechanism === "driver" || e.mechanism === "wmi") return;
      for (const path of [e.image, e.target]) if (path && !map.has(path.toLowerCase())) map.set(path.toLowerCase(), e);
    });
    return map;
  }, [persist]);
  const startupLookup = useMemo(
    () => ({
      find: (exe: string | null) => (exe ? (entryByExe.get(exe.toLowerCase()) ?? null) : null),
      open: (id: string) => {
        setPersistSelected(id);
        router.replace(`${pathname}?vue=persistance`, { scroll: false });
      },
    }),
    [entryByExe, router, pathname],
  );
  const runningPid = useCallback((path: string | null) => (path ? (pidByExe.get(path.toLowerCase()) ?? null) : null), [pidByExe]);
  const freshPersist = persist ? persist.entries.filter((e) => trust(e) === "new").length : null; // hors Microsoft

  const established = net?.connections.filter((c) => c.status === "ESTABLISHED").length;
  // « Joignables » = liés au réseau ET autorisés par le pare-feu (et non simplement liés à 0.0.0.0).
  const reachable = exposure ? exposure.summary.open : null;

  return (
    <StartupLookup.Provider value={startupLookup}>
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
          <Stat label="Persistances nouvelles" value={freshPersist ?? "—"} tone={freshPersist ? "critical" : undefined} />
          <Stat label="Durcissement" value={hard ? `${hard.summary.grade} · ${hard.summary.ok}/${hard.summary.total}` : "—"} tone={hard ? GRADE_TONE[hard.summary.grade] : undefined} />
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

      {view === "persistance" && (
        <div className={`${GRID} lg:grid-rows-2`}>
          <PersistenceView
            snapshot={persist}
            error={persistError}
            user={user}
            runningPid={runningPid}
            selected={persistSelected}
            onSelect={setPersistSelected}
            onChanged={loadPersistence}
            onOpenProcess={openProcess}
          />
        </div>
      )}

      {view === "durcissement" && (
        <div className={`${GRID} lg:grid-rows-[minmax(0,1.2fr)_minmax(0,1fr)]`}>
          <HardeningView snapshot={hard} history={remedyLog} error={hardError} user={user} onChanged={loadHardening} />
        </div>
      )}
    </StartupLookup.Provider>
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
