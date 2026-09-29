"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import type { NavStats } from "@/lib/api";
import { TONE_VAR } from "@/lib/posture";
import { NavGlyph, type NavIcon } from "./nav-icons";

// three.js n'est chargé que côté navigateur ; l'affiche Blender tient la place pendant le chargement.
const Emblem = dynamic(() => import("@/components/three/emblem"), {
  ssr: false,
  // eslint-disable-next-line @next/next/no-img-element -- petite affiche statique, pas d'optimisation utile
  loading: () => <img src="/models/emblem_poster.png" alt="" className="h-full w-full object-contain" />,
});

type BadgeKey = "home" | "system" | "logs" | "alerts" | "rules";

interface NavItem {
  label: string;
  href: string;
  icon: NavIcon;
  badge?: BadgeKey;
}

export const NAV_SECTIONS: { title: string; items: NavItem[] }[] = [
  {
    title: "Surveiller",
    items: [
      { label: "Accueil", href: "/dashboard", icon: "home", badge: "home" },
      { label: "Système", href: "/dashboard/machines", icon: "system", badge: "system" },
      { label: "Journaux", href: "/dashboard/events", icon: "logs", badge: "logs" },
    ],
  },
  {
    title: "Détecter",
    items: [
      { label: "Alertes", href: "/dashboard/alerts", icon: "alerts", badge: "alerts" },
      { label: "Règles", href: "/dashboard/rules", icon: "rules", badge: "rules" },
      { label: "MITRE ATT&CK", href: "/dashboard/mitre", icon: "mitre" },
    ],
  },
  {
    title: "Enrichir",
    items: [
      { label: "Threat Intel", href: "/dashboard/threat-intel", icon: "intel" },
      { label: "Assistant IA", href: "/dashboard/ai-assistant", icon: "ai" },
      { label: "Rapports", href: "/dashboard/reports", icon: "reports" },
    ],
  },
  { title: "Administrer", items: [{ label: "Administration", href: "/dashboard/admin", icon: "admin" }] },
];

const COLLECTION: Record<NavStats["collection"], { tone: string; label: string }> = {
  ok: { tone: "accent", label: "Collecte complète" },
  degraded: { tone: "warn", label: "Collecte partielle" },
  down: { tone: "critical", label: "Collecte arrêtée" },
  unknown: { tone: "muted", label: "Collecte : état inconnu" },
};

/** Badge vivant d'une entrée : le chiffre qui compte, dans la couleur qui dit s'il faut agir. */
function badgeFor(key: BadgeKey | undefined, nav: NavStats | null): { text: string; tone: string; title: string } | null {
  if (!key || !nav) return null;
  switch (key) {
    case "home":
      return nav.posture_score === null ? null : { text: String(nav.posture_score), tone: TONE_VAR[nav.posture_tone], title: `Posture ${nav.posture_score}/100` };
    case "alerts":
      return nav.open_alerts ? { text: nav.open_alerts > 99 ? "99+" : String(nav.open_alerts), tone: nav.open_critical ? "critical" : "warn", title: `${nav.open_alerts} alerte(s) à traiter, dont ${nav.open_critical} critique(s)` } : null;
    case "logs":
      return nav.events_5min ? { text: `+${nav.events_5min > 999 ? "999" : nav.events_5min}`, tone: "accent", title: `${nav.events_5min} événement(s) ces 5 dernières minutes` } : null;
    case "system": {
      const cpu = nav.cpu_percent;
      if (cpu === null) return null;
      return { text: `${Math.round(cpu)}%`, tone: cpu >= 85 ? "critical" : cpu >= 60 ? "warn" : "muted", title: `Processeur ${Math.round(cpu)} %` };
    }
    case "rules":
      return nav.rules_enabled ? { text: String(nav.rules_enabled), tone: "muted", title: `${nav.rules_enabled} règle(s) personnalisée(s) active(s)` } : null;
  }
}

interface SidebarProps {
  mode: "rail" | "full"; // rail : réduit, s'élargit au survol ; full : toujours ouvert (épinglé ou mobile)
  pathname: string;
  nav: NavStats | null;
  pinned: boolean;
  onPin?: () => void;
  onSearch: () => void;
  className?: string;
}

export function Sidebar({ mode, pathname, nav, pinned, onPin, onSearch, className = "" }: SidebarProps) {
  const rail = mode === "rail";
  const reveal = rail ? "opacity-0 transition-opacity duration-200 group-hover:opacity-100" : "";
  const tone = nav ? TONE_VAR[nav.posture_tone] : "muted";
  const collection = COLLECTION[nav?.collection ?? "unknown"];
  const critical = (nav?.open_critical ?? 0) > 0;

  return (
    <aside
      className={`${className} ${rail ? "group w-16 hover:w-64" : "w-64"} flex-col overflow-hidden border-r border-line transition-[width] duration-300 ease-out`}
      style={{
        background: `radial-gradient(140% 38% at 0% 0%, color-mix(in srgb, #fbbf77 9%, transparent), transparent 70%), radial-gradient(120% 30% at 50% 100%, rgba(var(--glow), 0.06), transparent 70%), var(--surface)`,
      }}
    >
      {/* Emblème 3D + identité + posture */}
      <div className="flex h-[64px] shrink-0 items-center gap-2.5 border-b border-line px-2.5">
        <div className="h-11 w-11 shrink-0">
          <Emblem tone={nav?.posture_tone ?? "unknown"} critical={critical} label={`Emblème DeTecTX : posture ${nav?.posture_score ?? "inconnue"}`} />
        </div>
        <div className={`min-w-0 whitespace-nowrap ${reveal}`}>
          <p className="font-display text-lg font-bold leading-none tracking-tight">
            De<span className="text-accent">Tec</span>TX
          </p>
          <p className="mt-1 text-[10px] font-medium" style={{ color: `var(--${tone})` }}>
            {nav?.posture_score !== null && nav?.posture_score !== undefined ? `Posture ${nav.posture_score}/100` : "Posture…"}
          </p>
        </div>
      </div>

      {/* Palette de commandes */}
      <div className="shrink-0 px-2.5 pt-3">
        <button
          onClick={onSearch}
          className="flex h-9 w-full items-center gap-3 rounded-lg border border-line bg-surface-2/60 px-3 text-xs text-muted transition hover:border-accent/50 hover:text-foreground"
          title="Rechercher, aller à… (Ctrl K)"
        >
          <NavGlyph icon="search" className="h-4 w-4 shrink-0" />
          <span className={`flex flex-1 items-center justify-between whitespace-nowrap ${reveal}`}>
            Rechercher, aller à…
            <kbd className="rounded border border-line px-1 font-mono text-[10px]">Ctrl K</kbd>
          </span>
        </button>
      </div>

      <nav className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-2 [perspective:900px]" aria-label="Navigation principale">
        {NAV_SECTIONS.map((section) => (
          <div key={section.title} className="mt-2 first:mt-0">
            <p className={`mb-1 h-4 px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted/70 ${reveal}`}>{section.title}</p>
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const active = item.href === pathname;
                const badge = badgeFor(item.badge, nav);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      aria-current={active ? "page" : undefined}
                      title={rail ? item.label : undefined}
                      className={`relative flex h-10 items-center gap-3 rounded-xl px-1.5 text-sm transition-all duration-200 [transform-origin:left_center] ${
                        active
                          ? "bg-gradient-to-r from-accent/15 via-accent/5 to-transparent text-foreground shadow-[0_10px_24px_-14px_rgba(var(--glow),0.9)]"
                          : "text-muted hover:translate-x-0.5 hover:bg-surface-2/60 hover:text-foreground hover:[transform:rotateY(-7deg)]"
                      }`}
                    >
                      {active && <span className="absolute -left-2.5 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r-full bg-accent" style={{ boxShadow: "0 0 12px rgba(var(--glow),0.9)" }} />}
                      {/* Touche « 3D » : dégradé, reflet en haut, ombre portée */}
                      <span
                        className={`relative grid h-8 w-8 shrink-0 place-items-center rounded-lg border ${active ? "border-accent/40 text-accent" : "border-line/70 text-muted"}`}
                        style={{
                          background: active
                            ? "linear-gradient(145deg, color-mix(in srgb, var(--accent) 22%, var(--surface-2)), var(--surface))"
                            : "linear-gradient(145deg, var(--surface-2), var(--surface))",
                          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.07), 0 5px 12px -6px rgba(0,0,0,0.7)",
                        }}
                      >
                        <NavGlyph icon={item.icon} className="h-4 w-4" />
                        {badge && rail && (
                          <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full border-2 border-surface group-hover:hidden" style={{ backgroundColor: `var(--${badge.tone})` }} aria-hidden="true" />
                        )}
                      </span>
                      <span className={`min-w-0 flex-1 truncate whitespace-nowrap ${reveal}`}>{item.label}</span>
                      {badge && (
                        <span
                          title={badge.title}
                          className={`mr-1 shrink-0 rounded-full px-1.5 py-px font-mono text-[10px] font-semibold tabular-nums ${reveal}`}
                          style={{ color: `var(--${badge.tone})`, backgroundColor: `color-mix(in srgb, var(--${badge.tone}) 15%, transparent)` }}
                        >
                          {badge.text}
                        </span>
                      )}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      {/* Pied : état de la collecte + épingle */}
      <div className="flex h-12 shrink-0 items-center gap-2.5 border-t border-line px-5">
        <span className="relative flex h-2 w-2 shrink-0" title={collection.label}>
          {nav?.collection === "ok" && <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-60" style={{ backgroundColor: `var(--${collection.tone})` }} />}
          <span className="relative inline-flex h-2 w-2 rounded-full" style={{ backgroundColor: `var(--${collection.tone})` }} />
        </span>
        <span className={`min-w-0 flex-1 truncate whitespace-nowrap text-[11px] text-muted ${reveal}`}>
          {collection.label} · v0.1
        </span>
        {onPin && (
          <button
            onClick={onPin}
            aria-pressed={pinned}
            title={pinned ? "Détacher la barre (repli automatique)" : "Épingler la barre ouverte"}
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition ${pinned ? "bg-accent/15 text-accent" : "text-muted hover:text-foreground"} ${reveal}`}
          >
            <NavGlyph icon="pin" className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
    </aside>
  );
}
