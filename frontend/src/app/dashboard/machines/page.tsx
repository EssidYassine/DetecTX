"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMetrics,
  fetchProcesses,
  killProcess,
  type Metrics,
  type ProcInfo,
} from "@/lib/api";
import { AreaChart, Gauge } from "@/components/charts";
import { EmptyState } from "@/components/ui";
import { fmtBytes, fmtUptime, loadTone } from "@/lib/host";

const N = 40; // fenêtre du graphe temps réel

export default function MachinesPage() {
  const [m, setM] = useState<Metrics | null>(null);
  const [procs, setProcs] = useState<ProcInfo[]>([]);
  const [cpuSeries, setCpu] = useState<number[]>([]);
  const [ramSeries, setRam] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const tick = useCallback(async () => {
    try {
      const data = await fetchMetrics();
      setM(data);
      setCpu((s) => [...s, data.cpu_percent].slice(-N));
      setRam((s) => [...s, data.ram_percent].slice(-N));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    }
  }, []);

  const loadProcs = useCallback(async () => {
    setProcs(await fetchProcesses(40).catch(() => []));
  }, []);

  useEffect(() => {
    void tick();
    void loadProcs();
    timer.current = setInterval(() => {
      void tick();
    }, 2000);
    const pt = setInterval(() => void loadProcs(), 5000);
    return () => {
      if (timer.current) clearInterval(timer.current);
      clearInterval(pt);
    };
  }, [tick, loadProcs]);

  async function onKill(p: ProcInfo) {
    if (!confirm(`Terminer le processus « ${p.name ?? p.pid} » (PID ${p.pid}) ?`)) return;
    try {
      await killProcess(p.pid);
      await loadProcs();
    } catch (e) {
      alert(e instanceof Error ? e.message : "Échec");
    }
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
        </span>
        <div>
          <h1 className="text-lg font-semibold">Santé de la machine</h1>
          <p className="text-sm text-muted">Supervision temps réel du poste · rafraîchi toutes les 2 s</p>
        </div>
      </div>

      {error && (
        <p className="rounded-md border border-critical/40 bg-critical/10 px-3 py-2 text-sm text-critical">{error}</p>
      )}

      {/* Jauges + info système */}
      <section className="grid gap-4 lg:grid-cols-4">
        <div className="panel flex items-center justify-center p-5">
          <Gauge value={m?.cpu_percent ?? 0} label="CPU" sub={`${m?.cpu_count ?? "—"} cœurs`} />
        </div>
        <div className="panel flex items-center justify-center p-5">
          <Gauge value={m?.ram_percent ?? 0} label="RAM" sub={m ? `${fmtBytes(m.ram_used)} / ${fmtBytes(m.ram_total)}` : ""} />
        </div>
        <div className="panel flex flex-col justify-center gap-3 p-5 lg:col-span-2">
          <Info label="Disponibilité (uptime)" value={m ? fmtUptime(m.uptime_seconds) : "—"} />
          <Info label="Processus actifs" value={m ? String(m.process_count) : "—"} />
          <div className="grid grid-cols-2 gap-3">
            <Info label="Réseau ↓" value={m ? `${fmtBytes(m.net_down)}/s` : "—"} tone="ok" />
            <Info label="Réseau ↑" value={m ? `${fmtBytes(m.net_up)}/s` : "—"} tone="accent" />
          </div>
        </div>
      </section>

      {/* Graphes temps réel */}
      <section className="grid gap-4 lg:grid-cols-2">
        <LivePanel title="CPU — temps réel" value={m?.cpu_percent} series={cpuSeries} />
        <LivePanel title="Mémoire — temps réel" value={m?.ram_percent} series={ramSeries} />
      </section>

      {/* Disques */}
      <section className="panel p-5">
        <h2 className="mb-4 font-medium">Disques</h2>
        <div className="space-y-4">
          {(m?.disks ?? []).map((d) => (
            <div key={d.mount}>
              <div className="mb-1 flex justify-between text-sm">
                <span className="font-mono text-muted">{d.mount}</span>
                <span className="tabular-nums">{fmtBytes(d.used)} / {fmtBytes(d.total)} · {d.percent}%</span>
              </div>
              <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${d.percent}%`, backgroundColor: `var(--${loadTone(d.percent)})` }} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Processus */}
      <section className="panel">
        <div className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-medium">Processus (par mémoire)</h2>
          <span className="text-xs text-muted">clic sur « Tuer » pour terminer</span>
        </div>
        {procs.length === 0 ? (
          <EmptyState>Chargement des processus…</EmptyState>
        ) : (
          <div className="max-h-[460px] overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-surface text-xs uppercase tracking-wide text-muted">
                <tr className="border-b border-line">
                  <th className="px-5 py-2 font-medium">PID</th>
                  <th className="px-3 py-2 font-medium">Nom</th>
                  <th className="px-3 py-2 font-medium">CPU</th>
                  <th className="px-3 py-2 font-medium">Mémoire</th>
                  <th className="px-5 py-2 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {procs.map((p) => (
                  <tr key={p.pid} className="border-b border-line/50 hover:bg-surface-2">
                    <td className="px-5 py-2 font-mono text-xs text-muted">{p.pid}</td>
                    <td className="px-3 py-2 font-mono text-xs">{p.name ?? "—"}</td>
                    <td className="px-3 py-2 tabular-nums">{p.cpu_percent}%</td>
                    <td className="px-3 py-2 tabular-nums">{p.memory_percent}%</td>
                    <td className="px-5 py-2 text-right">
                      <button onClick={() => onKill(p)}
                        className="rounded border border-line px-2 py-1 text-xs text-muted transition hover:border-critical/50 hover:text-critical">
                        Tuer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function Info({ label, value, tone = "foreground" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-sm tabular-nums" style={{ color: `var(--${tone})` }}>{value}</span>
    </div>
  );
}

function LivePanel({ title, value, series }: { title: string; value?: number; series: number[] }) {
  const tone = loadTone(value ?? 0);
  return (
    <div className="panel">
      <div className="flex items-center justify-between border-b border-line px-5 py-3">
        <h2 className="font-medium">{title}</h2>
        <span className="text-lg font-semibold tabular-nums" style={{ color: `var(--${tone})` }}>
          {value !== undefined ? `${Math.round(value)}%` : "—"}
        </span>
      </div>
      {series.length > 1 ? (
        <AreaChart data={series} tone={tone} height={160} showAxis={false} />
      ) : (
        <EmptyState>Acquisition…</EmptyState>
      )}
    </div>
  );
}
