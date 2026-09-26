"use client";

import { Suspense, useCallback, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { searchAlerts, runDetection, type Alert } from "@/lib/api";
import { SeverityBadge } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { AlertDrawer } from "@/components/alert-drawer";
import { ReportButton } from "@/components/report-button";

const SEVERITIES = ["all", "critical", "high", "medium", "low"] as const;

const COLUMNS: Column<Alert>[] = [
  { header: "Sévérité", cell: (a) => <SeverityBadge severity={a.severity} /> },
  { header: "Risque", cell: (a) => <span className="font-mono tabular-nums">{a.risk_score}</span> },
  { header: "Règle", cell: (a) => a.rule_title },
  { header: "MITRE", cell: (a) => <span className="font-mono text-xs text-accent">{a.mitre ?? "—"}</span> },
  { header: "Canal", cell: (a) => <span className="text-xs text-muted">{a.channel ?? "—"}</span> },
  {
    header: "Détail",
    className: "max-w-sm truncate text-muted",
    cell: (a) => a.message ?? "—",
  },
];

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function AlertsPage() {
  return (
    <Suspense fallback={null}>
      <AlertsView />
    </Suspense>
  );
}

function AlertsView() {
  const router = useRouter();
  const sp = useSearchParams();
  const mitre = sp.get("mitre") ?? undefined;
  const spSev = sp.get("severity");
  const [severity, setSeverity] = useState<(typeof SEVERITIES)[number]>(
    (SEVERITIES as readonly string[]).includes(spSev ?? "") ? (spSev as (typeof SEVERITIES)[number]) : "all",
  );
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [selected, setSelected] = useState<Alert | null>(null);

  const fetchPage = useCallback(
    (p: { offset: number; limit: number; q: string }) =>
      searchAlerts({ ...p, severity, mitre }),
    [severity, mitre],
  );

  async function handleRun() {
    setRunning(true);
    setNotice(null);
    try {
      const res = await runDetection();
      setNotice(`${res.rules_run} règles exécutées, ${res.alerts_created} nouvelle(s) alerte(s).`);
      setRefreshKey((k) => k + 1);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : "Détection impossible");
    } finally {
      setRunning(false);
    }
  }

  const toolbar = (
    <div className="flex gap-1 rounded-lg bg-surface-2 p-1 text-sm">
      {SEVERITIES.map((s) => (
        <button
          key={s}
          onClick={() => setSeverity(s)}
          className={`rounded-md px-3 py-1 capitalize transition ${
            severity === s ? "bg-accent text-accent-fg" : "text-muted hover:text-foreground"
          }`}
        >
          {s === "all" ? "Toutes" : s}
        </button>
      ))}
    </div>
  );

  return (
    <>
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold">Alertes de sécurité</h1>
        <div className="flex items-center gap-2">
          <ReportButton />
          <button
            onClick={handleRun}
            disabled={running}
            className="rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50"
          >
            {running ? "Analyse…" : "Lancer la détection"}
          </button>
        </div>
      </div>

      {mitre && (
        <div className="flex items-center gap-2 text-sm">
          <span className="rounded-full border border-accent/40 bg-accent/10 px-3 py-1 text-accent">
            Filtré · MITRE {mitre}
          </span>
          <button onClick={() => router.push("/dashboard/alerts")} className="text-muted transition hover:text-foreground">
            ✕ effacer
          </button>
        </div>
      )}

      {notice && <Notice text={notice} />}

      <DataTable
        columns={COLUMNS}
        fetchPage={fetchPage}
        rowKey={(a) => (a as Alert).id}
        searchPlaceholder="Rechercher une règle / un détail…"
        toolbar={toolbar}
        emptyMessage="Aucune alerte. Collectez des événements puis lancez la détection."
        refreshKey={refreshKey}
        onRowClick={(a) => setSelected(a as Alert)}
      />

      <AlertDrawer alert={selected} onClose={() => setSelected(null)} />
    </>
  );
}

function Notice({ text }: { text: string }) {
  const isWarn = /indisponible|impossible|opensearch|erreur/i.test(text);
  const tone = isWarn ? "warn" : "ok";
  return (
    <div
      className="flex items-start gap-3 rounded-lg border px-4 py-3 text-sm"
      style={{
        color: `var(--${tone})`,
        borderColor: `color-mix(in srgb, var(--${tone}) 40%, transparent)`,
        backgroundColor: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
      }}
    >
      <span className="mt-0.5 shrink-0">{isWarn ? "⚠" : "✓"}</span>
      <p>{text}</p>
    </div>
  );
}
