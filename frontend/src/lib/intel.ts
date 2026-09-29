// Threat Intel : vocabulaire partagé (indicateurs du poste, tamis, vulnérabilités). Sans three.js.

import type { IntelIndicator, IntelOverview, VulnFinding } from "@/lib/api";

export const TYPE_LABEL: Record<IntelIndicator["type"], string> = { ip: "IP", domain: "Domaine", hash: "Programme" };
export const VERDICT_LABEL: Record<IntelIndicator["verdict"], string> = { malicious: "Malveillant", suspicious: "À surveiller", unknown: "Rien de connu" };
export const VERDICT_TONE: Record<IntelIndicator["verdict"], string> = { malicious: "critical", suspicious: "warn", unknown: "muted" };
export const SIGHTING_LABEL: Record<string, string> = { connexion: "Connexion active", programme: "Programme en cours", journal: "Journal", alerte: "Alerte" };

/** Disques du tamis, de haut en bas (repris de assets/3d/build_sieve.py). */
export const SIEVE_LAYERS = [
  { id: "feeds", label: "Listes publiques", providers: [] as string[] },
  { id: "abuseipdb", label: "AbuseIPDB", providers: ["abuseipdb"] },
  { id: "virustotal", label: "VirusTotal", providers: ["virustotal"] },
  { id: "misp-otx", label: "MISP / OTX", providers: ["misp", "otx"] },
] as const;

/** Un disque est actif si sa source fonctionne : au moins une liste chargée, ou une clé configurée. */
export function layerActive(ov: IntelOverview, index: number): boolean {
  if (index === 0) return ov.totals.feeds_active > 0;
  const ids: readonly string[] = SIEVE_LAYERS[index].providers;
  return ov.providers.some((p) => ids.includes(p.id) && p.configured);
}

export const STATUS_LABEL: Record<VulnFinding["status"], string> = { vulnerable: "Vulnérable", unknown: "À vérifier", fixed: "Déjà corrigé" };
export const STATUS_TONE: Record<VulnFinding["status"], string> = { vulnerable: "critical", unknown: "warn", fixed: "accent" };

export function shortValue(v: string): string {
  return v.length > 24 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
