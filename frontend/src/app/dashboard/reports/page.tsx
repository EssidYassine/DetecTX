"use client";

import { useState } from "react";
import { downloadReport } from "@/lib/api";

export default function ReportsPage() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onDownload() {
    setLoading(true);
    setError(null);
    try {
      await downloadReport();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <div>
        <h1 className="text-lg font-semibold">Rapports</h1>
        <p className="text-sm text-muted">Générez un rapport PDF à partir des données de votre poste.</p>
      </div>

      <div className="max-w-md rounded-xl border border-line bg-surface p-6">
        <div className="flex items-start gap-4">
          <span className="grid h-12 w-12 shrink-0 place-items-center rounded-xl bg-accent/15 text-accent">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M9 13h6M9 17h6" />
            </svg>
          </span>
          <div>
            <h2 className="font-medium">Rapport de synthèse</h2>
            <p className="mt-1 text-sm text-muted">
              KPIs, alertes par sévérité, techniques MITRE et principales alertes.
            </p>
          </div>
        </div>
        <button
          onClick={onDownload}
          disabled={loading}
          className="mt-5 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-fg transition hover:brightness-110 disabled:opacity-50"
        >
          {loading ? "Génération…" : "Télécharger le PDF"}
        </button>
        {error && <p className="mt-3 text-sm text-critical">{error}</p>}
      </div>
    </>
  );
}
