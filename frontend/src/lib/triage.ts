// Vocabulaire du triage des alertes (libellés et couleurs partagés).

import type { AlertStatus, Resolution } from "@/lib/api";

export const STATUS_LABEL: Record<AlertStatus, string> = {
  new: "Nouvelle",
  ack: "En cours",
  closed: "Clôturée",
};

/** Couleur de statut : l'attention va aux nouvelles ; le rouge reste réservé au critique. */
export const STATUS_TONE: Record<AlertStatus, "accent" | "warn" | "muted"> = {
  new: "accent",
  ack: "warn",
  closed: "muted",
};

export const RESOLUTION_LABEL: Record<Resolution, string> = {
  true_positive: "Vrai positif",
  false_positive: "Faux positif",
  benign: "Bénin",
};

export const RESOLUTIONS: Resolution[] = ["true_positive", "false_positive", "benign"];
