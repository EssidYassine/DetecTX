"use client";

import { useCallback, useRef, useState, type ReactNode, type Ref, type RefObject } from "react";

interface Point {
  x: number;
  y: number;
}

export type PanelHover<T extends Point> = T & { flipX: boolean; flipY: boolean };

function place(el: HTMLElement, x: number, y: number, flipX: boolean, flipY: boolean) {
  el.style.left = `${x + (flipX ? -14 : 14)}px`;
  el.style.top = `${y + (flipY ? -14 : 14)}px`;
  el.style.transform = `translate(${flipX ? "-100%" : "0"}, ${flipY ? "-100%" : "0"})`;
}

/**
 * Convertit un survol 3D (coordonnées écran) en infobulle locale au panneau, retournée
 * près des bords droit/bas pour ne jamais être coupée.
 *
 * Perf : React ne re-rend que quand la CIBLE change (clé `keyOf`) ; tant qu'on reste sur
 * le même objet, l'infobulle suit la souris par manipulation directe du DOM (aucun rendu
 * React ni reconciliation de la scène 3D à chaque pixel). `keyOf` doit être stable.
 */
export function usePanelHover<T extends Point>(panel: RefObject<HTMLElement | null>, keyOf: (h: T) => string | number) {
  const [hover, setHover] = useState<PanelHover<T> | null>(null);
  const tip = useRef<HTMLDivElement>(null);
  const currentKey = useRef<string | number | null>(null);

  const onHover = useCallback(
    (h: T | null) => {
      const rect = panel.current?.getBoundingClientRect();
      if (!h || !rect) {
        currentKey.current = null;
        setHover(null);
        return;
      }
      const x = h.x - rect.left;
      const y = h.y - rect.top;
      const flipX = x > rect.width - 260;
      const flipY = y > rect.height - 110;
      const key = keyOf(h);
      if (key === currentKey.current && tip.current) {
        place(tip.current, x, y, flipX, flipY); // même cible : on déplace seulement
        return;
      }
      currentKey.current = key;
      setHover({ ...h, x, y, flipX, flipY });
    },
    [panel, keyOf],
  );
  return [hover, onHover, tip] as const;
}

export function HoverTip({ hover, tipRef, children }: { hover: PanelHover<Point>; tipRef: Ref<HTMLDivElement>; children: ReactNode }) {
  return (
    <div
      ref={tipRef}
      className="pointer-events-none absolute z-20 max-w-[16rem] rounded-lg border border-line bg-surface-2/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
      style={{
        left: hover.x + (hover.flipX ? -14 : 14),
        top: hover.y + (hover.flipY ? -14 : 14),
        transform: `translate(${hover.flipX ? "-100%" : "0"}, ${hover.flipY ? "-100%" : "0"})`,
      }}
    >
      {children}
    </div>
  );
}
