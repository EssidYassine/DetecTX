// Pictogrammes de la navigation (SVG 16×16, trait 1,6 px, couleur héritée) : remplacent les
// caractères Unicode (▦ ◈ ≣…) dont le rendu variait selon la police.

export type NavIcon = "home" | "system" | "network" | "logs" | "alerts" | "rules" | "mitre" | "intel" | "search" | "pin";

const PATHS: Record<NavIcon, string> = {
  home: "M2.5 7.2 8 2.8l5.5 4.4V13a.8.8 0 0 1-.8.8H9.6V10H6.4v3.8H3.3a.8.8 0 0 1-.8-.8V7.2Z",
  system: "M2.2 3h11.6v7.6H2.2V3ZM5.6 13.4h4.8M8 10.6v2.8M5 8.2l1.6-2 1.6 1.4 2.8-2.8",
  // Réseau local : la box au centre, trois appareils reliés.
  network: "M6.4 6.4h3.2v3.2H6.4zM8 6.4V3.6M8 9.6v2.8M6.4 8H3.6M9.6 8h2.8M2.6 2.2h2v2h-2zM11.4 2.2h2v2h-2zM7 12.4h2v2H7z",
  logs: "M3 3.5h10M3 6.5h10M3 9.5h7M3 12.5h5",
  alerts: "M4 11V7.5a4 4 0 0 1 8 0V11l1 1.4H3L4 11ZM6.6 13.8a1.5 1.5 0 0 0 2.8 0",
  rules: "M2.5 3h11l-4.2 5.2v4.6l-2.6 1.2V8.2L2.5 3Z",
  mitre: "M2.5 2.5h4.4v4.4H2.5zM9.1 2.5h4.4v4.4H9.1zM2.5 9.1h4.4v4.4H2.5zM9.1 9.1h4.4v4.4H9.1z",
  intel: "M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2ZM8 5.2a2.8 2.8 0 1 0 0 5.6 2.8 2.8 0 0 0 0-5.6ZM8 .8V3M8 13v2.2M.8 8H3M13 8h2.2",
  search: "M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM10.3 10.3l3.2 3.2",
  pin: "M9.6 2.2l4.2 4.2-2 .6-2.6 2.6.4 3-1.2 1.2-2.4-2.4-3.2 3.2M5.2 9.6 2.8 7.2 4 6l3 .4 2.6-2.6.6-2",
};

export function NavGlyph({ icon, className = "" }: { icon: NavIcon; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[icon]} />
    </svg>
  );
}
