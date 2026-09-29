"use client";

import { useState } from "react";
import type { VulnFinding, VulnReport } from "@/lib/api";
import { fmtDate, STATUS_LABEL, STATUS_TONE } from "@/lib/intel";

const SECURITY_CATEGORY = /^(security updates|critical updates|mises à jour de sécurité|mises à jour critiques)$/i;

interface VulnsViewProps {
  report: VulnReport | null;
  isAdmin: boolean;
  onRescan: () => void;
  notice: string | null;
}

/** Vulnérabilités DE CE SYSTÈME : mises à jour Windows manquantes + logiciels × KEV vérifiés via NVD. */
export function VulnsView({ report, isAdmin, onRescan, notice }: VulnsViewProps) {
  const updates = report?.windows_update.updates ?? [];
  // Catégories officielles de Windows Update (et non le mot « Security » dans un titre : « Windows
  // Security platform » est une mise à jour de définitions, pas un correctif de sécurité).
  const security = updates.filter((u) => u.categories.some((c) => SECURITY_CATEGORY.test(c)) || u.severity);
  const findings = report?.findings ?? [];
  const by = (s: VulnFinding["status"]) => findings.filter((f) => f.status === s);
  const vulnerable = by("vulnerable");
  const unknown = by("unknown");
  const fixed = by("fixed");
  const upToDate = report?.windows_update.available && updates.length === 0;
  const tone = vulnerable.length ? "critical" : security.length ? "warn" : updates.length || unknown.length ? "warn" : "accent";

  return (
    <>
      {/* État du système */}
      <div className="panel flex min-h-0 flex-col overflow-hidden lg:col-span-4 lg:row-span-2">
        <div className="border-b border-line px-4 py-2.5">
          <span className="eyebrow">État du système</span>
        </div>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">
          <div className="rounded-2xl border border-line p-4" style={{ background: `radial-gradient(120% 120% at 0% 0%, color-mix(in srgb, var(--${tone}) 12%, transparent), transparent 60%)` }}>
            <p className="text-[11px] text-muted">{report?.os.product ?? "Windows"}</p>
            <p className="font-display text-lg font-semibold">
              {report?.os.display_version ?? "—"} <span className="font-mono text-sm text-muted">build {report?.os.build ?? "—"}</span>
            </p>
            <p className="mt-3 text-sm font-medium" style={{ color: `var(--${tone})` }}>
              {!report?.scanned_at
                ? report?.running
                  ? "Première analyse en cours…"
                  : "Pas encore analysé"
                : vulnerable.length
                  ? `${vulnerable.length} logiciel(s) vulnérable(s) à une faille activement exploitée`
                  : upToDate && !unknown.length
                    ? "Système à jour, aucune faille activement exploitée détectée"
                    : `${updates.length} mise(s) à jour Windows en attente`}
            </p>
          </div>

          <dl className="grid grid-cols-2 gap-2 text-center">
            <Stat label="Mises à jour en attente" value={updates.length} tone={updates.length ? "warn" : "accent"} />
            <Stat label="Dont sécurité" value={security.length} tone={security.length ? "critical" : "accent"} />
            <Stat label="Logiciels analysés" value={report?.software_count ?? 0} tone="muted" />
            <Stat label="Failles KEV connues" value={report?.kev_entries ?? 0} tone="muted" />
          </dl>

          <div className="space-y-1 text-[11px] text-muted">
            <p>Dernière analyse : {fmtDate(report?.scanned_at)} {report?.running && <span className="text-accent">· analyse en cours…</span>}</p>
            <p>Analyse automatique toutes les 12 h (Windows Update prend environ une minute).</p>
            {report?.windows_update.error && <p className="text-warn">{report.windows_update.error}</p>}
          </div>
          {isAdmin && (
            <button onClick={onRescan} disabled={report?.running} className="w-full rounded-lg border border-line px-3 py-2 text-xs transition hover:border-accent/60 hover:text-accent disabled:opacity-50">
              {report?.running ? "Analyse en cours…" : "Relancer l'analyse"}
            </button>
          )}
          {notice && <p className="text-[11px] text-accent">{notice}</p>}
          <p className="text-[10px] leading-relaxed text-muted">
            Sources : Agent Windows Update (recherche seule, rien n&apos;est installé), catalogue CISA KEV des failles activement exploitées, plages de versions de la base NVD (seul le numéro CVE est envoyé). Les produits Microsoft sont couverts par Windows Update.
          </p>
        </div>
      </div>

      {/* Mises à jour Windows */}
      <div className="panel flex min-h-0 flex-col overflow-hidden lg:col-span-8">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="eyebrow">Mises à jour Windows en attente</span>
          <span className="font-mono text-xs text-muted">{updates.length}</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {updates.length === 0 ? (
            <p className="p-4 text-center text-sm text-muted">{report?.windows_update.available ? "Windows est à jour." : "Résultat de Windows Update pas encore disponible."}</p>
          ) : (
            <ul className="space-y-1.5">
              {updates.map((u) => (
                <li key={u.title} className="rounded-lg border border-line px-3 py-2">
                  <p className="text-sm font-medium">{u.title}</p>
                  <p className="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-muted">
                    {u.kbs.map((kb) => (
                      <a key={kb} href={`https://support.microsoft.com/help/${kb.replace("KB", "")}`} target="_blank" rel="noreferrer noopener" className="font-mono text-accent hover:underline">
                        {kb}
                      </a>
                    ))}
                    <span>{u.categories.join(" · ")}</span>
                    {u.severity && <span className="text-warn">gravité {u.severity}</span>}
                    {u.reboot && <span>redémarrage requis</span>}
                    {u.cves.length > 0 && <span className="font-mono">{u.cves.slice(0, 4).join(", ")}</span>}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 px-1 text-[11px] text-muted">Installez-les depuis Paramètres › Windows Update : DeTecTX ne modifie jamais le système.</p>
        </div>
      </div>

      {/* Logiciels × KEV */}
      <div className="panel flex min-h-0 flex-col overflow-hidden lg:col-span-8">
        <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
          <span className="eyebrow">Logiciels et failles activement exploitées (CISA KEV)</span>
          <span className="text-[11px] text-muted">
            <span className="text-critical">{vulnerable.length} vulnérable(s)</span> · <span className="text-warn">{unknown.length} à vérifier</span> · <span className="text-accent">{fixed.length} déjà corrigée(s)</span>
          </span>
        </div>
        <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
          {findings.length === 0 && <p className="p-4 text-center text-sm text-muted">Aucun logiciel installé ne figure dans le catalogue KEV (hors Microsoft).</p>}
          {[...vulnerable, ...unknown].map((f) => (
            <FindingRow key={`${f.software.name}:${f.kev.cveID}`} f={f} />
          ))}
          {fixed.length > 0 && <FixedGroup items={fixed} />}
        </div>
      </div>
    </>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-lg border border-line px-2 py-2">
      <dd className="font-mono text-lg font-semibold tabular-nums" style={{ color: `var(--${tone === "muted" ? "foreground" : tone})` }}>
        {value.toLocaleString("fr-FR")}
      </dd>
      <dt className="text-[10px] text-muted">{label}</dt>
    </div>
  );
}

function FindingRow({ f }: { f: VulnFinding }) {
  const tone = STATUS_TONE[f.status];
  return (
    <div className="rounded-lg border px-3 py-2" style={{ borderColor: `color-mix(in srgb, var(--${tone}) 40%, transparent)`, backgroundColor: `color-mix(in srgb, var(--${tone}) 6%, transparent)` }}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded px-1.5 py-px text-[10px] font-semibold uppercase" style={{ color: `var(--${tone})`, backgroundColor: `color-mix(in srgb, var(--${tone}) 15%, transparent)` }}>
          {STATUS_LABEL[f.status]}
        </span>
        <span className="text-sm font-medium">{f.software.name}</span>
        <span className="font-mono text-[11px] text-muted">v{f.software.version || "?"}</span>
        <a href={`https://nvd.nist.gov/vuln/detail/${f.kev.cveID}`} target="_blank" rel="noreferrer noopener" className="ml-auto font-mono text-[11px] text-accent hover:underline">
          {f.kev.cveID} ↗
        </a>
      </div>
      <p className="mt-1 text-xs">{f.kev.vulnerabilityName}</p>
      <p className="mt-0.5 text-[11px] text-muted">
        {f.fixed_in ? `Corrigé à partir de la version ${f.fixed_in}. ` : ""}
        {f.kev.requiredAction}
        {f.kev.knownRansomwareCampaignUse === "Known" && <span className="ml-1 font-medium text-critical">Utilisée par des rançongiciels.</span>}
      </p>
    </div>
  );
}

function FixedGroup({ items }: { items: VulnFinding[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-accent/30 bg-accent/5 px-3 py-2">
      <button onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center justify-between text-left text-xs">
        <span className="text-accent">
          ✓ {items.length} faille(s) KEV concernant vos logiciels, déjà corrigée(s) par les versions installées
        </span>
        <span className="text-muted">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ul className="mt-2 space-y-1 text-[11px]">
          {items.map((f) => (
            <li key={`${f.software.name}:${f.kev.cveID}`} className="flex flex-wrap gap-x-2">
              <span className="font-medium">{f.software.name}</span>
              <span className="font-mono text-muted">v{f.software.version}</span>
              <span className="font-mono text-accent">{f.kev.cveID}</span>
              {f.fixed_in && <span className="text-muted">corrigée en {f.fixed_in}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
