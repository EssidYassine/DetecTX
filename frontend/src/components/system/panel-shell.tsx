"use client";

import type { ReactNode, Ref } from "react";

interface PanelShellProps {
  title: string;
  /** Valeur principale affichée en haut à droite (ex. « 42 % »). */
  value?: ReactNode;
  /** Ton de la valeur : nom de variable CSS (accent, warn, critical…). */
  tone?: string;
  aside?: ReactNode;
  footer?: ReactNode;
  panelRef?: Ref<HTMLDivElement>;
  className?: string;
  children: ReactNode;
}

/** Cadre commun des panneaux de la page Système : en-tête, scène 3D extensible, pied. */
export function PanelShell({ title, value, tone, aside, footer, panelRef, className = "", children }: PanelShellProps) {
  return (
    <div ref={panelRef} className={`panel relative flex min-h-0 flex-col overflow-hidden ${className}`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-2.5">
        <span className="eyebrow">{title}</span>
        {aside}
        {value !== undefined && (
          <span className="font-mono text-lg font-semibold tabular-nums" style={tone ? { color: `var(--${tone})` } : undefined}>
            {value}
          </span>
        )}
      </div>
      <div className="relative min-h-0 flex-1">{children}</div>
      {footer && <div className="border-t border-line px-4 py-2 text-xs text-muted">{footer}</div>}
    </div>
  );
}
