"use client";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { fetchMetrics, fetchProcesses, killProcess, type Metrics, type ProcInfo } from "@/lib/api";
import { fmtBytes, fmtUptime } from "@/lib/host";
import { CpuPanel, RamPanel, StoragePanel } from "@/components/system/hardware-panels";
import { CityPanel } from "@/components/system/city-panel";
import { ProcessPanel } from "@/components/system/process-panel";

const METRICS_MS = 2000;
const PROCESSES_MS = 5000; // énumérer ~300 processus avec leurs détails coûte plus cher
const PROCESS_LIMIT = 60; // = MAX_BUILDINGS de la ville 3D

type Notice = { tone: "ok" | "critical"; text: string };

/** Page Système — « salle des machines » : CPU, RAM, stockage et processus en 3D, sans défilement. */
export default function MachinesPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [procs, setProcs] = useState<ProcInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [killing, setKilling] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const tick = useCallback(async () => {
    try {
      setM(await fetchMetrics());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Métriques indisponibles");
    }
  }, []);

  const loadProcs = useCallback(async () => {
    try {
      setProcs(await fetchProcesses(PROCESS_LIMIT));
      setNow(Date.now());
    } catch {
      // Liste conservée : une erreur ponctuelle ne doit pas vider la ville.
      setProcs((p) => p ?? []);
    }
  }, []);

  useEffect(() => {
    const first = window.setTimeout(() => {
      void tick();
      void loadProcs();
    }, 0);
    const mt = window.setInterval(() => void tick(), METRICS_MS);
    const pt = window.setInterval(() => void loadProcs(), PROCESSES_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(mt);
      window.clearInterval(pt);
    };
  }, [tick, loadProcs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const onSelect = useCallback((pid: number | null) => {
    setSelected(pid);
    setNotice(null);
  }, []);

  async function onKill(p: ProcInfo) {
    const label = p.name ?? `PID ${p.pid}`;
    if (!window.confirm(`Terminer le processus « ${label} » (PID ${p.pid}) ?\n\nLes données non enregistrées de ce programme seront perdues.`)) return;
    setKilling(true);
    try {
      await killProcess(p.pid);
      setSelected(null);
      setNotice({ tone: "ok", text: `« ${label} » (PID ${p.pid}) a été terminé.` });
      await loadProcs();
    } catch (e) {
      setNotice({ tone: "critical", text: e instanceof Error ? e.message : "Échec de l'arrêt du processus." });
    } finally {
      setKilling(false);
    }
  }

  const cpuCount = m?.cpu_count ?? 1;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
          </span>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold">
              Salle des machines <span className="font-mono text-base font-normal text-muted">· {m?.hostname ?? "—"}</span>
            </h1>
            <p className="truncate text-sm text-muted">Supervision temps réel du poste · métriques toutes les 2 s, processus toutes les 5 s</p>
          </div>
        </div>
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 text-xs">
          <Stat label="Uptime" value={m ? fmtUptime(m.uptime_seconds) : "—"} />
          <Stat label="Processus" value={m?.process_count ?? "—"} />
          <Stat label="Réseau ↓" value={m ? `${fmtBytes(m.net_down)}/s` : "—"} />
          <Stat label="Réseau ↑" value={m ? `${fmtBytes(m.net_up)}/s` : "—"} />
        </div>
      </div>

      {error && <p className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>}

      {/* Desktop : tout tient dans l'écran (même calcul que l'Overview) ; seule la liste des processus défile. */}
      <div className="grid gap-4 lg:h-[calc(100dvh-13.25rem)] lg:min-h-[520px] lg:grid-cols-12 lg:grid-rows-[minmax(0,1fr)_minmax(0,1.35fr)]">
        <CpuPanel metrics={m} className="h-64 lg:col-span-4 lg:h-auto" />
        <RamPanel metrics={m} className="h-64 lg:col-span-4 lg:h-auto" />
        <StoragePanel metrics={m} className="h-64 lg:col-span-4 lg:h-auto" />
        <CityPanel
          processes={procs ?? []}
          cpuCount={cpuCount}
          selected={selected}
          highlight={highlight}
          onHighlight={setHighlight}
          onSelect={onSelect}
          className="h-80 lg:col-span-8 lg:h-auto"
        />
        <ProcessPanel
          processes={procs}
          cpuCount={cpuCount}
          selected={selected}
          highlight={highlight}
          onHighlight={setHighlight}
          onSelect={onSelect}
          onKill={onKill}
          killing={killing}
          notice={notice}
          now={now}
          className="h-[28rem] lg:col-span-4 lg:h-auto"
        />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: ReactNode }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono tabular-nums">{value}</span>
    </span>
  );
}
