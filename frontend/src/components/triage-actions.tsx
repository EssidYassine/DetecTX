"use client";

import { useState } from "react";
import { triageAlert, type Alert, type TriageInput } from "@/lib/api";
import { RESOLUTION_LABEL, RESOLUTIONS, STATUS_LABEL, STATUS_TONE } from "@/lib/triage";

export function StatusPill({ alert }: { alert: Pick<Alert, "status" | "resolution"> }) {
  const tone = STATUS_TONE[alert.status];
  return (
    <span
      className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px]"
      style={{ color: `var(--${tone})`, borderColor: `color-mix(in srgb, var(--${tone}) 40%, transparent)` }}
    >
      {STATUS_LABEL[alert.status]}
      {alert.status === "closed" && alert.resolution && <span className="text-muted">· {RESOLUTION_LABEL[alert.resolution]}</span>}
    </span>
  );
}

/** Actions de triage d'une alerte (tiroir de détail). Clôturer exige une conclusion. */
export function TriageActions({ alert, onChanged }: { alert: Alert; onChanged: (updated: Alert) => void }) {
  const [busy, setBusy] = useState(false);
  const [closing, setClosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function apply(input: TriageInput) {
    setBusy(true);
    setError(null);
    try {
      onChanged(await triageAlert(alert.id, input));
      setClosing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Triage impossible");
    } finally {
      setBusy(false);
    }
  }

  const btn = "rounded-lg border border-line px-3 py-1.5 text-sm transition hover:border-accent/60 hover:text-accent disabled:opacity-50";

  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2/40 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <StatusPill alert={alert} />
        {alert.triaged_by && alert.triaged_at && (
          <span className="text-[11px] text-muted">
            dernier triage : {alert.triaged_by} · {new Date(alert.triaged_at).toLocaleString("fr-FR")}
          </span>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {alert.status === "new" && (
          <button disabled={busy} onClick={() => apply({ status: "ack" })} className={btn}>
            Prendre en charge
          </button>
        )}
        {alert.status !== "closed" && (
          <button disabled={busy} onClick={() => setClosing((v) => !v)} className={btn} aria-expanded={closing}>
            Clôturer ▾
          </button>
        )}
        {alert.status !== "new" && (
          <button disabled={busy} onClick={() => apply({ status: "new" })} className={btn}>
            Rouvrir
          </button>
        )}
      </div>
      {closing && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Conclusion :</span>
          {RESOLUTIONS.map((r) => (
            <button key={r} disabled={busy} onClick={() => apply({ status: "closed", resolution: r })} className={btn}>
              {RESOLUTION_LABEL[r]}
            </button>
          ))}
        </div>
      )}
      {error && <p className="text-xs text-critical">{error}</p>}
    </div>
  );
}
