"use client";

import { useEffect } from "react";

/** Applique le thème stocké au montage (sans UI). Défaut = sombre. */
export function ThemeApplier() {
  useEffect(() => {
    const stored = localStorage.getItem("detectx_theme");
    if (stored === "light") {
      document.documentElement.setAttribute("data-theme", "light");
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }, []);
  return null;
}
