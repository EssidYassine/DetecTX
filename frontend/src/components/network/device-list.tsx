"use client";

import { useMemo, useState } from "react";
import type { NetDevice } from "@/lib/api";
import { displayName, isPresent, RISK_LABEL, RISK_RANK, RISK_TONE, STATUS_LABEL, STATUS_TONE } from "@/lib/sonar";
import { fmtAgo } from "@/lib/time";

type Filter = "all" | "todo" | "exposed" | "present";
const FILTERS: { key: Filter; label: string }[] = [
  { key: "all", label: "Tous" },
  { key: "todo", label: "À vérifier" },
  { key: "exposed", label: "Exposés" },
  { key: "present", label: "Présents" },
];

const needsReview = (d: NetDevice) => d.gateway_mismatch || d.status === "new";
const exposed = (d: NetDevice) => RISK_RANK[d.risk] >= RISK_RANK.high;

interface DeviceListProps {
  devices: NetDevice[];
  now: number;
  selected: string | null;
  onSelect: (id: string) => void;
  className?: string;
}

/** Inventaire du réseau local, ce qui demande une action en premier (ordre rendu par l'API). */
export function DeviceList({ devices, now, selected, onSelect, className = "" }: DeviceListProps) {
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const counts: Record<Filter, number> = {
    all: devices.length,
    todo: devices.filter(needsReview).length,
    exposed: devices.filter(exposed).length,
    present: devices.filter((d) => isPresent(d, now)).length,
  };
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return devices.filter(
      (d) =>
        (filter === "all" || (filter === "todo" ? needsReview(d) : filter === "exposed" ? exposed(d) : isPresent(d, now))) &&
        (!needle || [d.ip, d.mac, d.label, d.hostname, d.vendor, d.kind_label].some((v) => v?.toLowerCase().includes(needle))),
    );
  }, [devices, filter, q, now]);

  return (
    <div className={`panel flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-2">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            aria-pressed={filter === f.key}
            className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs transition ${filter === f.key ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"}`}
          >
            {f.label}
            <span className={`font-mono text-[10px] ${f.key === "todo" && counts.todo ? "text-warn" : ""}`}>{counts[f.key]}</span>
          </button>
        ))}
        <input
          value={q}
          onChange={(e) => setQ(e.target.value.slice(0, 100))}
          placeholder="Filtrer (nom, IP, MAC, fabricant…)"
          aria-label="Filtrer les appareils"
          className="ml-auto w-full min-w-0 rounded-lg border border-line bg-surface-2 px-2 py-1 text-xs outline-none focus:border-accent/60 sm:w-48"
        />
      </div>
      {shown.length === 0 ? (
        <p className="grid flex-1 place-items-center p-6 text-center text-sm text-muted">
          {devices.length === 0 ? "Aucun appareil encore vu sur ce réseau. Le premier relevé arrive dans la minute." : "Aucun appareil ne correspond."}
        </p>
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-line overflow-y-auto">
          {shown.map((d) => {
            const present = isPresent(d, now);
            const active = d.id === selected;
            return (
              <li key={d.id}>
                <button
                  onClick={() => onSelect(d.id)}
                  aria-current={active}
                  className={`flex w-full items-center gap-3 px-3 py-2 text-left transition ${active ? "bg-accent/10" : "hover:bg-surface-2"} ${present ? "" : "opacity-60"}`}
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${present ? "bg-accent" : "bg-muted"}`} title={present ? "présent" : "absent"} />
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{displayName(d)}</span>
                      {d.is_gateway && <span className="rounded bg-surface-2 px-1.5 text-[10px] text-muted">box</span>}
                    </span>
                    <span className="block truncate text-[11px] text-muted">
                      {d.kind_label} · <span className="font-mono">{d.ip}</span>
                      {d.vendor ? ` · ${d.vendor}` : d.randomized_mac ? " · adresse privée" : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 flex-col items-end gap-1">
                    {d.gateway_mismatch ? (
                      <span className="rounded bg-critical/15 px-1.5 text-[10px] font-medium text-critical">usurpe la box ?</span>
                    ) : (
                      <span className="rounded px-1.5 text-[10px]" style={{ color: `var(--${STATUS_TONE[d.status]})`, backgroundColor: `color-mix(in srgb, var(--${STATUS_TONE[d.status]}) 14%, transparent)` }}>
                        {STATUS_LABEL[d.status]}
                      </span>
                    )}
                    <span className="text-[10px]" style={{ color: `var(--${RISK_TONE[d.risk]})` }}>
                      {d.ports_scanned_at ? `${RISK_LABEL[d.risk]}${d.open_ports ? ` · ${d.open_ports} port${d.open_ports > 1 ? "s" : ""}` : ""}` : present ? "présent" : fmtAgo(d.last_seen, now)}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
