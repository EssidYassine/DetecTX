// Pré-remplissage d'une règle de détection à partir d'un événement réel ou d'une recherche.

import type { EventDetail } from "@/lib/api";
import { channelLabel, fmtDateTime } from "@/lib/events-ui";

export type RuleLevel = "critical" | "high" | "medium" | "low";

export interface RuleSeed {
  title: string;
  channel: string | null;
  eventId: number | null;
  keywords: string[]; // présélectionnés
  suggestions: string[]; // proposés (puces cliquables)
  level: RuleLevel;
  mitre: string | null;
  description: string;
  origin: string; // d'où vient la règle (traçabilité)
}

// Champs les plus parlants d'abord (processus, fichiers, comptes, services, réseau…).
const PREFERRED = [
  "Image", "CommandLine", "ParentImage", "TargetFilename", "ImagePath", "ServiceName", "TaskName", "TargetUserName", "SubjectUserName",
  "QueryName", "DestinationIp", "DestinationHostname", "RuleName", "ApplicationPath", "Threat Name", "SSID", "url", "Path", "User",
];
const MAX_SUGGESTIONS = 8;
const CODE_TOKEN = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]{3,}\b/g; // ex. WTS_SESSION_UNLOCK
const LEVEL: Record<string, RuleLevel> = { info: "low", low: "low", medium: "medium", high: "high" };

/** Valeur utilisable comme mot-clé : un chemin long devient son nom de fichier (plus robuste). */
function keywordOf(value: string): string | null {
  let v = value.trim().replace(/^"+|"+$/g, "");
  if (/^[A-Za-z]:\\|^\\\\|^\\Device\\/.test(v) && v.length > 40) v = v.split("\\").pop() ?? v;
  if (v.length < 2 || v.length > 200 || ["-", "%%1", "0", "null"].includes(v)) return null;
  return v;
}

export function suggestKeywords(detail: EventDetail): string[] {
  const out: string[] = [];
  const add = (v: unknown) => {
    const k = typeof v === "string" ? keywordOf(v) : null;
    if (k && k !== detail.provider && !out.some((x) => x.toLowerCase() === k.toLowerCase())) out.push(k);
  };
  const text = [detail.message ?? "", ...Object.values(detail.fields).map(String)].join(" ");
  for (const token of text.match(CODE_TOKEN) ?? []) add(token);
  for (const key of PREFERRED) add(detail.fields[key]);
  for (const [key, value] of Object.entries(detail.fields)) if (/^Data\d+$/.test(key)) add(value);
  return out.slice(0, MAX_SUGGESTIONS);
}

export function seedFromEvent(detail: EventDetail): RuleSeed {
  const k = detail.knowledge;
  const suggestions = suggestKeywords(detail);
  const when = fmtDateTime(detail.timestamp);
  const origin = `Événement ${channelLabel(detail.channel)} n° ${detail.event_id ?? "—"} du ${when}`;
  return {
    title: (detail.summary ?? k?.title ?? `Événement ${detail.event_id ?? ""}`).slice(0, 120),
    channel: detail.channel,
    eventId: detail.event_id,
    // ID connu du catalogue : il suffit à lui seul ; sinon on cible d'emblée le code distinctif.
    keywords: k ? [] : suggestions.slice(0, 1),
    suggestions,
    level: k ? (LEVEL[k.level] ?? "medium") : "medium",
    mitre: k?.attack ?? null,
    description: [k?.what, `Créée depuis : ${origin}.`].filter(Boolean).join("\n"),
    origin,
  };
}

export function seedFromSearch(params: { channel: string; eventId: number | null; q: string }): RuleSeed {
  const what = [params.channel && channelLabel(params.channel), params.eventId !== null && `ID ${params.eventId}`, params.q && `« ${params.q} »`].filter(Boolean).join(" · ");
  const origin = `Recherche ${what || "sans filtre"}`;
  return {
    title: params.q ? `Recherche « ${params.q} »`.slice(0, 120) : `Surveillance ${what}`.slice(0, 120),
    channel: params.channel || null,
    eventId: params.eventId,
    keywords: params.q ? [params.q] : [],
    suggestions: [],
    level: "medium",
    mitre: null,
    description: `Créée depuis : ${origin}.`,
    origin,
  };
}
