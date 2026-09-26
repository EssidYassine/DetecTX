"use client";

import { Suspense, useCallback, useState } from "react";
import { useSearchParams } from "next/navigation";
import { searchEvents, type EventItem } from "@/lib/api";
import { LevelBadge, shortChannel } from "@/components/ui";
import { DataTable, type Column } from "@/components/data-table";
import { ReportButton } from "@/components/report-button";

const CHANNELS = [
  { value: "", label: "Tous les canaux" },
  { value: "Security", label: "Security" },
  { value: "System", label: "System" },
  { value: "Application", label: "Application" },
  { value: "Microsoft-Windows-Sysmon/Operational", label: "Sysmon" },
  { value: "Microsoft-Windows-PowerShell/Operational", label: "PowerShell" },
  { value: "DeTecTX-FileMonitor", label: "Activité fichiers" },
  { value: "DeTecTX-LogFile", label: "Fichiers .log" },
];

const COLUMNS: Column<EventItem>[] = [
  {
    header: "Heure",
    className: "whitespace-nowrap font-mono text-xs text-muted",
    cell: (e) => new Date(e.timestamp).toLocaleString(),
  },
  {
    header: "Canal",
    cell: (e) => (
      <span className="rounded bg-surface-2 px-2 py-0.5 text-xs">{shortChannel(e.channel)}</span>
    ),
  },
  { header: "ID", className: "font-mono text-xs", cell: (e) => e.event_id ?? "—" },
  { header: "Niveau", cell: (e) => <LevelBadge level={e.level} /> },
  {
    header: "Message",
    className: "max-w-md truncate text-muted",
    cell: (e) => e.message ?? "—",
  },
];

// useSearchParams() exige une frontière Suspense pour que Next puisse pré-rendre la page.
export default function EventsPage() {
  return (
    <Suspense fallback={null}>
      <EventsView />
    </Suspense>
  );
}

/** Fenêtre « dernières N minutes » lisible (fournie par le cadran 24 h de l'Overview). */
function windowLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

function EventsView() {
  const sp = useSearchParams();
  const [channel, setChannel] = useState(sp.get("channel") ?? "");
  const rawMinutes = Number(sp.get("minutes"));
  const [minutes, setMinutes] = useState<number | undefined>(
    Number.isInteger(rawMinutes) && rawMinutes > 0 && rawMinutes <= 7 * 24 * 60 ? rawMinutes : undefined,
  );

  const fetchPage = useCallback(
    (p: { offset: number; limit: number; q: string }) =>
      searchEvents({ ...p, channel: channel || undefined, minutes }),
    [channel, minutes],
  );

  const toolbar = (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={channel}
        onChange={(e) => setChannel(e.target.value)}
        className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm outline-none focus:border-accent"
      >
        {CHANNELS.map((c) => (
          <option key={c.value} value={c.value}>{c.label}</option>
        ))}
      </select>
      {minutes !== undefined && (
        <span className="flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-2.5 py-1.5 text-xs text-accent">
          Fenêtre · dernières {windowLabel(minutes)}
          <button onClick={() => setMinutes(undefined)} className="text-muted transition hover:text-foreground" aria-label="Retirer le filtre de fenêtre">
            ✕
          </button>
        </span>
      )}
    </div>
  );

  return (
    <>
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Journaux Windows</h1>
        <ReportButton />
      </div>
      <DataTable
        columns={COLUMNS}
        fetchPage={fetchPage}
        rowKey={(_, i) => i}
        searchPlaceholder="Rechercher dans le message…"
        toolbar={toolbar}
        emptyMessage="Aucun événement. Lancez le collecteur (collectors/README.md)."
      />
    </>
  );
}
