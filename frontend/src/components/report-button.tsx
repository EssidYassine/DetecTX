"use client";

import { useState } from "react";
import { downloadReport } from "@/lib/api";

export function ReportButton({ label = "Rapport PDF" }: { label?: string }) {
  const [loading, setLoading] = useState(false);

  async function go() {
    setLoading(true);
    try {
      await downloadReport();
    } catch {
      // silencieux : l'utilisateur réessaiera
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      onClick={go}
      disabled={loading}
      title="Télécharger le rapport PDF"
      className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:border-accent/60 hover:text-accent disabled:opacity-50"
    >
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9zM14 3v6h6M12 12v6M9 15l3 3 3-3" />
      </svg>
      {loading ? "…" : label}
    </button>
  );
}
