"use client";

import { useEffect, useState } from "react";
import { notifyStatus, notifyTest } from "@/lib/api";

export default function AdminPage() {
  const [discord, setDiscord] = useState<boolean | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  useEffect(() => {
    notifyStatus().then((s) => setDiscord(s.discord)).catch(() => setDiscord(false));
  }, []);

  async function test() {
    setTesting(true);
    setResult(null);
    try {
      const r = await notifyTest();
      setResult(r.detail);
    } catch (e) {
      setResult(e instanceof Error ? e.message : "Erreur");
    } finally {
      setTesting(false);
    }
  }

  return (
    <>
      <h1 className="text-lg font-semibold">Administration</h1>

      <div className="max-w-lg rounded-xl border border-line bg-surface p-6">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-medium">Notifications Discord</h2>
            <p className="mt-1 text-sm text-muted">
              Alerte automatique des nouvelles alertes critiques/élevées vers un salon Discord.
            </p>
          </div>
          <span
            className="rounded-full px-2.5 py-1 text-xs font-medium"
            style={{
              color: discord ? "var(--ok)" : "var(--muted)",
              backgroundColor: `color-mix(in srgb, var(--${discord ? "ok" : "muted"}) 15%, transparent)`,
            }}
          >
            {discord === null ? "…" : discord ? "Configuré" : "Non configuré"}
          </span>
        </div>

        {!discord && (
          <p className="mt-4 rounded-md border border-line bg-surface-2 px-3 py-2 text-xs text-muted">
            Définissez <code className="text-accent">DISCORD_WEBHOOK_URL</code> dans la configuration
            du backend, puis redémarrez, pour activer les notifications.
          </p>
        )}

        <button
          onClick={test}
          disabled={testing}
          className="mt-4 rounded-lg border border-line px-4 py-2 text-sm transition hover:border-accent/60 hover:text-accent disabled:opacity-50"
        >
          {testing ? "Envoi…" : "Envoyer un message de test"}
        </button>
        {result && <p className="mt-3 text-sm text-muted">{result}</p>}
      </div>
    </>
  );
}
