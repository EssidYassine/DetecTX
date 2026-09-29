// Tactiques MITRE ATT&CK (Enterprise) dans l'ordre de la kill chain, + couloir « Non classé ».
// Utilisé par le radar des menaces (secteurs Sector_00..14, assets/3d/build_radar.py).

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
