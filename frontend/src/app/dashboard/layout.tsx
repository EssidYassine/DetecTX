"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, fetchMe, getToken, SESSION_EXPIRED_EVENT, type User } from "@/lib/api";
import { ThemeToggle } from "@/components/theme-toggle";
import { AiChatWidget } from "@/components/ai-chat-widget";

type NavItem = { label: string; href?: string; icon: string };

const NAV: NavItem[] = [
  { label: "Accueil", href: "/dashboard", icon: "▦" },
  { label: "Système", href: "/dashboard/machines", icon: "▤" },
  { label: "Alertes", href: "/dashboard/alerts", icon: "◈" },
  { label: "Logs", href: "/dashboard/events", icon: "≣" },
  { label: "Règles", href: "/dashboard/rules", icon: "◆" },
  { label: "MITRE ATT&CK", href: "/dashboard/mitre", icon: "⛨" },
  { label: "Threat Intel", href: "/dashboard/threat-intel", icon: "☈" },
  { label: "Administration", href: "/dashboard/admin", icon: "⚙" },
  { label: "Incidents", icon: "❖" },
  { label: "Recherche", icon: "⌕" },
];

function SidebarNav({
  mode,
  pathname,
  className = "",
}: {
  mode: "rail" | "full";
  pathname: string;
  className?: string;
}) {
  const rail = mode === "rail";
  const labelCls = rail
    ? "whitespace-nowrap opacity-0 transition-opacity duration-200 group-hover:opacity-100"
    : "whitespace-nowrap";

  return (
    <aside
      className={`${className} ${rail ? "group w-16 hover:w-60" : "w-64"} flex-col overflow-hidden border-r border-line bg-surface transition-[width] duration-300 ease-out`}
    >
      <div className="flex h-[57px] items-center gap-2 border-b border-line px-4">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-accent font-bold text-accent-fg">
          D
        </span>
        <span className={`font-display text-lg font-bold tracking-tight ${labelCls}`}>
          De<span className="text-accent">Tec</span>TX
        </span>
      </div>

      <nav className="flex-1 space-y-1 p-3 text-sm">
        {NAV.map((item) => {
          const active = item.href === pathname;
          const base = "relative flex items-center gap-3 rounded-lg px-3 py-2 transition";
          if (!item.href) {
            return (
              <div key={item.label} className={`${base} cursor-not-allowed text-muted/40`} title="À venir">
                <span className="w-4 shrink-0 text-center">{item.icon}</span>
                <span className={labelCls}>{item.label}</span>
              </div>
            );
          }
          return (
            <Link
              key={item.label}
              href={item.href}
              className={`${base} ${
                active
                  ? "bg-surface-2 text-foreground"
                  : "text-muted hover:bg-surface-2/60 hover:text-foreground"
              }`}
            >
              {active && (
                <span
                  className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-accent"
                  style={{ boxShadow: "0 0 8px rgba(var(--glow),0.9)" }}
                />
              )}
              <span className="w-4 shrink-0 text-center text-accent/80">{item.icon}</span>
              <span className={labelCls}>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <div className={`border-t border-line p-3 text-xs text-muted ${labelCls}`}>
        v0.1.0 · mono-hôte
      </div>
    </aside>
  );
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    fetchMe()
      .then(setUser)
      .catch(() => {
        clearToken();
        router.replace("/login");
      });
  }, [router]);

  // Session expirée (401 remonté par lib/api) : retour propre à la connexion.
  useEffect(() => {
    const onExpired = () => router.replace("/login?expired=1");
    window.addEventListener(SESSION_EXPIRED_EVENT, onExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onExpired);
  }, [router]);

  // Ferme le drawer mobile quand on change de page.
  useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  function logout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <div className="relative flex flex-1">
      {/* Réserve la largeur du rail sur desktop (le rail réel est en overlay) */}
      <div className="hidden w-16 shrink-0 md:block" />

      {/* Rail desktop : réduit, s'étend au survol */}
      <SidebarNav
        mode="rail"
        pathname={pathname}
        className="absolute inset-y-0 left-0 z-30 hidden md:flex"
      />

      {/* Drawer mobile + fond */}
      <div
        onClick={() => setMobileOpen(false)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity md:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <SidebarNav
        mode="full"
        pathname={pathname}
        className={`fixed inset-y-0 left-0 z-50 flex transition-transform duration-300 md:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface/60 px-4 py-3 backdrop-blur sm:px-6">
          <button
            onClick={() => setMobileOpen(true)}
            aria-label="Ouvrir le menu"
            className="grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-line text-muted transition hover:text-accent md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M3 6h18M3 12h18M3 18h18" />
            </svg>
          </button>

          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-60" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-accent" />
              </span>
              <span className="eyebrow">Surveillance active</span>
            </div>
            <p className="truncate font-display text-base font-semibold tracking-tight sm:text-lg">
              Mon poste Windows
            </p>
          </div>

          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <ThemeToggle />
            {user && (
              <div className="hidden text-right text-sm sm:block">
                <p className="max-w-[180px] truncate font-medium">{user.email}</p>
                <p className="text-xs text-accent">{user.role}</p>
              </div>
            )}
            <button
              onClick={logout}
              className="rounded-lg border border-line px-3 py-1.5 text-sm text-muted transition hover:border-critical/50 hover:text-critical"
            >
              Déconnexion
            </button>
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6">
          <div key={pathname} className="animate-page space-y-6">
            {children}
          </div>
        </main>
      </div>

      <AiChatWidget />
    </div>
  );
}
