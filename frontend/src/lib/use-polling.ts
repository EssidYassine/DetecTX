"use client";

import { useEffect } from "react";

/**
 * Exécute `task` tout de suite puis toutes les `ms` millisecondes :
 * - tours sautés tant que l'onglet est caché (pas de requêtes inutiles) ;
 * - rafraîchissement immédiat au retour sur l'onglet (pas de données périmées) ;
 * - jamais deux requêtes simultanées : un tour est sauté tant que le précédent n'a pas répondu.
 * `task` doit être stable (useCallback) : la changer relance le cycle.
 */
export function usePolling(task: () => Promise<void>, ms: number) {
  useEffect(() => {
    let inFlight = false;
    const run = () => {
      if (inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      void task().finally(() => {
        inFlight = false;
      });
    };
    const first = window.setTimeout(run, 0);
    const id = window.setInterval(run, ms);
    document.addEventListener("visibilitychange", run);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", run);
    };
  }, [task, ms]);
}
