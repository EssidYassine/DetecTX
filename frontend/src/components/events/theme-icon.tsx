import type { ThemeIcon as Icon } from "@/lib/events-ui";

/** Pictogrammes des thèmes (SVG maison, trait 1,6 px, couleur héritée). */
const PATHS: Record<Icon, string> = {
  user: "M8 8.2a2.7 2.7 0 1 0 0-5.4 2.7 2.7 0 0 0 0 5.4ZM3 13.6c.6-2.4 2.6-3.9 5-3.9s4.4 1.5 5 3.9",
  shield: "M8 1.8 13 3.6v4c0 3.1-2.1 5.5-5 6.6-2.9-1.1-5-3.5-5-6.6v-4L8 1.8Z",
  terminal: "M2.2 3h11.6v10H2.2V3ZM4.6 6.2l2 1.8-2 1.8M8.4 10h3",
  wifi: "M1.8 6.2a9 9 0 0 1 12.4 0M3.9 8.5a6 6 0 0 1 8.2 0M6 10.8a3 3 0 0 1 4 0M8 13.2h.01",
  chip: "M4.2 4.2h7.6v7.6H4.2V4.2ZM6.4 1.8v2.4M9.6 1.8v2.4M6.4 11.8v2.4M9.6 11.8v2.4M1.8 6.4h2.4M1.8 9.6h2.4M11.8 6.4h2.4M11.8 9.6h2.4",
  window: "M2 3h12v10H2V3ZM2 5.8h12M4 4.4h.01M5.6 4.4h.01",
};

export function ThemeIcon({ icon, className = "" }: { icon: Icon; className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d={PATHS[icon]} />
    </svg>
  );
}
