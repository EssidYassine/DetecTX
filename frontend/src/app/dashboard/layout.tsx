"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { usePathname, useRouter } from "next/navigation";
import { clearToken, fetchMe, fetchNavStats, getToken, SESSION_EXPIRED_EVENT, type NavStats, type User } from "@/lib/api";
import { usePolling } from "@/lib/use-polling";
import { Sidebar } from "@/components/nav/sidebar";
import { CommandPalette } from "@/components/nav/command-palette";
import { ThemeToggle } from "@/components/theme-toggle";
import { AiChatWidget } from "@/components/ai-chat-widget";

const PIN_KEY = "detectx_sidebar_pinned";
const PIN_EVENT = "detectx-sidebar-pin";
const NAV_MS = 30_000;

// Préférence « barre épinglée » : lue via useSyncExternalStore (aucun écart d'hydratation :
// le rendu serveur voit « non épinglée », le navigateur corrige sans effet ni double rendu).
function subscribePin(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(PIN_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(PIN_EVENT, onChange);
  };
}
const readPin = () => localStorage.getItem(PIN_KEY) === "1";
const readPinServer = () => false;
function writePin(value: boolean) {
  localStorage.setItem(PIN_KEY, value ? "1" : "0");
  window.dispatchEvent(new Event(PIN_EVENT));
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [user, setUser] = useState<User | null>(null);
  // Tiroir mobile ouvert POUR une page donnée : changer de page le ferme de lui-même (état dérivé, sans effet).
  const [mobileFor, setMobileFor] = useState<string | null>(null);
  const mobileOpen = mobileFor === pathname;
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [nav, setNav] = useState<NavStats | null>(null);
  const pinned = useSyncExternalStore(subscribePin, readPin, readPinServer);
  const togglePin = useCallback(() => writePin(!readPin()), []);

  // Badges vivants de la barre latérale (posture, alertes, activité…).
  const loadNav = useCallback(async () => {
    const n = await fetchNavStats().catch(() => null);
    if (n) setNav(n);
  }, []);
  usePolling(loadNav, NAV_MS);

  // Ctrl+K / Cmd+K : palette de commandes, depuis n'importe quelle page.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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

  function logout() {
    clearToken();
    router.replace("/login");
  }

  return (
    <div className="relative flex flex-1">
      {/* Réserve la largeur de la barre sur desktop (rail 64 px, ou 256 px épinglée) */}
      <div className={`hidden shrink-0 transition-[width] duration-300 md:block ${pinned ? "w-64" : "w-16"}`} />

      {/* Barre desktop : rail qui s'élargit au survol, ou ouverte si épinglée */}
      <Sidebar
        mode={pinned ? "full" : "rail"}
        pathname={pathname}
        nav={nav}
        pinned={pinned}
        onPin={togglePin}
        onSearch={() => setPaletteOpen(true)}
        className="absolute inset-y-0 left-0 z-30 hidden md:flex"
      />

      {/* Drawer mobile + fond */}
      <div
        onClick={() => setMobileFor(null)}
        aria-hidden
        className={`fixed inset-0 z-40 bg-black/50 backdrop-blur-sm transition-opacity md:hidden ${
          mobileOpen ? "opacity-100" : "pointer-events-none opacity-0"
        }`}
      />
      <Sidebar
        mode="full"
        pathname={pathname}
        nav={nav}
        pinned={false}
        onSearch={() => setPaletteOpen(true)}
        className={`fixed inset-y-0 left-0 z-50 flex transition-transform duration-300 md:hidden ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-3 border-b border-line bg-surface/60 px-4 py-3 backdrop-blur sm:px-6">
          <button
            onClick={() => setMobileFor(pathname)}
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
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} pinned={pinned} onTogglePin={togglePin} />
    </div>
  );
}
