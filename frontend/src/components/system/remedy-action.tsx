"use client";

import { useRef, useState } from "react";

interface RemedyActionProps {
  label: string; // libellé du bouton (« Corriger », « Désactiver au démarrage »…)
  title: string; // ce qui sera fait
  change: string; // modification exacte (clé de registre, compte, tâche…)
  reboot?: boolean;
  revertible?: boolean;
  undoHint?: string; // comment revenir en arrière (par défaut : l'historique des corrections)
  elevated?: boolean; // passe par l'invite UAC de Windows
  tone?: "critical" | "warn" | "accent";
  busy: boolean;
  disabled?: boolean;
  onConfirm: () => void;
}

/** Bouton de remède avec confirmation en ligne : dit exactement ce qui change avant d'agir. */
export function RemedyAction({ label, title, change, reboot, revertible = true, undoHint = "« Annuler » dans l'historique des corrections", elevated = true, tone = "accent", busy, disabled, onConfirm }: RemedyActionProps) {
  const [confirming, setConfirming] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const open = () => {
    setConfirming(true);
    // La fiche défile : la confirmation doit apparaître à l'écran, pas sous le pli.
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  const color = `var(--${tone})`;

  if (!confirming) {
    return (
      <button
        onClick={open}
        disabled={busy || disabled}
        className="w-full rounded-md border px-3 py-1.5 text-xs font-semibold transition hover:brightness-125 disabled:opacity-50"
        style={{ color, borderColor: `color-mix(in srgb, ${color} 45%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 8%, transparent)` }}
      >
        {busy ? "Correction en cours…" : label}
      </button>
    );
  }
  return (
    <div ref={box} className="rounded-lg border p-2.5 text-xs" style={{ borderColor: `color-mix(in srgb, ${color} 40%, transparent)`, backgroundColor: `color-mix(in srgb, ${color} 5%, transparent)` }}>
      <p className="font-medium">{title}</p>
      <p className="mt-1 break-all font-mono text-[10px] text-muted">{change}</p>
      <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted">
        {elevated && <li>• Windows demandera une autorisation administrateur (invite UAC).</li>}
        {reboot && <li className="text-warn">• Effectif après un redémarrage.</li>}
        <li>{revertible ? `• Réversible : ${undoHint}.` : "• Ne se défait pas depuis DeTecTX."}</li>
      </ul>
      <div className="mt-2 flex gap-2">
        <button onClick={() => setConfirming(false)} className="flex-1 rounded-md border border-line px-2 py-1 text-muted transition hover:text-foreground">
          Annuler
        </button>
        <button
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
          disabled={busy}
          className="flex-1 rounded-md px-2 py-1 font-semibold text-white transition hover:brightness-110 disabled:opacity-50"
          style={{ backgroundColor: color }}
        >
          Confirmer
        </button>
      </div>
    </div>
  );
}
