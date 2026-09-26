// Tactiques MITRE ATT&CK (Enterprise) dans l'ordre de la kill chain, + couloir « Non classé ».
// L'ordre correspond aux couloirs Lane_00..14 du modèle Blender (assets/3d/build_skyline.py).

import type { Alert, MitreDetail } from "@/lib/api";

export interface Tactic {
  id: string | null; // null = technique absente de la base embarquée
  short: string; // libellé court (étiquette 3D)
  label: string; // libellé complet (infobulle)
}

export const TACTICS: Tactic[] = [
  { id: "reconnaissance", short: "Recon", label: "Reconnaissance" },
  { id: "resource-development", short: "Ressources", label: "Développement de ressources" },
  { id: "initial-access", short: "Accès init.", label: "Accès initial" },
  { id: "execution", short: "Exécution", label: "Exécution" },
  { id: "persistence", short: "Persistance", label: "Persistance" },
  { id: "privilege-escalation", short: "Privilèges", label: "Élévation de privilèges" },
  { id: "defense-evasion", short: "Évasion", label: "Contournement des défenses" },
  { id: "credential-access", short: "Identifiants", label: "Accès aux identifiants" },
  { id: "discovery", short: "Découverte", label: "Découverte" },
  { id: "lateral-movement", short: "Latéral", label: "Déplacement latéral" },
  { id: "collection", short: "Collecte", label: "Collecte" },
  { id: "command-and-control", short: "C2", label: "Commande et contrôle" },
  { id: "exfiltration", short: "Exfiltration", label: "Exfiltration" },
  { id: "impact", short: "Impact", label: "Impact" },
  { id: null, short: "Non classé", label: "Non classé (technique hors base)" },
];

export function laneOf(tactic: string | null): number {
  const i = TACTICS.findIndex((t) => t.id === tactic);
  return i === -1 ? TACTICS.length - 1 : i;
}

const SEVERITY_RANK: Record<Alert["severity"], number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Technique de la skyline, enrichie de la sévérité la plus grave de ses alertes. */
export interface SkylineTechnique extends MitreDetail {
  worst: Alert["severity"] | null;
}

export function withWorstSeverity(details: MitreDetail[], alerts: Alert[]): SkylineTechnique[] {
  const worst = new Map<string, Alert["severity"]>();
  for (const a of alerts) {
    if (!a.mitre) continue;
    const prev = worst.get(a.mitre);
    if (!prev || SEVERITY_RANK[a.severity] > SEVERITY_RANK[prev]) worst.set(a.mitre, a.severity);
  }
  return details.map((d) => ({ ...d, worst: worst.get(d.id) ?? null }));
}
