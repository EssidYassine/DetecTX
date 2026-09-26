"use client";

/**
 * Socle commun des widgets 3D du dashboard (modèles générés par Blender, cf. assets/3d/).
 *
 * <Stage> fournit à chaque widget : affiche Blender pendant le chargement / sans WebGL,
 * fond = var(--surface) du panneau, studio lumineux DeTecTX, Bloom néon, pause du rendu
 * hors écran ou onglet caché, et respect de prefers-reduced-motion.
 * Les scènes lisent la palette et le mode d'animation via useScene().
 *
 * N'importer ces modules qu'en différé (next/dynamic, ssr: false) : three.js ne doit
 * alourdir que les pages qui l'utilisent.
 */

import {
  Component,
  createContext,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { Environment, Lightformer } from "@react-three/drei";
import { Bloom, EffectComposer, SMAA, ToneMapping } from "@react-three/postprocessing";
import { ToneMappingMode } from "postprocessing";
import * as THREE from "three";
import { ScenePoster } from "./scene-poster";

// ─────────────────────────────── palette (variables CSS du thème actif)
export type PaletteKey = "accent" | "warn" | "critical" | "muted" | "surface";
export type Palette = Record<PaletteKey, THREE.Color>;

const FALLBACK: Record<PaletteKey, string> = {
  accent: "#2dd4bf",
  warn: "#fbbf24",
  critical: "#f43f5e",
  muted: "#8a97a9",
  surface: "#0f141d",
};

function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement);
  const entries = (Object.keys(FALLBACK) as PaletteKey[]).map((k) => [
    k,
    new THREE.Color(css.getPropertyValue(`--${k}`).trim() || FALLBACK[k]),
  ]);
  return Object.fromEntries(entries) as Palette;
}

/** Relit la palette quand le thème clair/sombre change (attribut data-theme sur <html>). */
function usePalette(): Palette {
  const [palette, setPalette] = useState(readPalette);
  useEffect(() => {
    const obs = new MutationObserver(() => setPalette(readPalette()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, []);
  return palette;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Vrai si la zone est à l'écran ET l'onglet visible : sinon on coupe la boucle de rendu. */
function useActive(ref: RefObject<HTMLElement | null>): boolean {
  const [inView, setInView] = useState(true);
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([entry]) => setInView(entry.isIntersecting), { threshold: 0.05 });
    io.observe(el);
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [ref]);
  return inView && visible;
}

function supportsWebGL(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Si le rendu 3D échoue (modèle absent, contexte perdu…), on garde l'affiche statique. */
class SceneBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.warn("[scene-kit] rendu 3D indisponible, affiche statique conservée :", error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

// ─────────────────────────────── contexte des scènes
interface SceneContextValue {
  palette: Palette;
  animate: boolean; // false si l'utilisateur préfère les animations réduites
}
const SceneContext = createContext<SceneContextValue | null>(null);

export function useScene(): SceneContextValue {
  const ctx = useContext(SceneContext);
  if (!ctx) throw new Error("useScene() doit être appelé dans un <Stage>");
  return ctx;
}

/** Couleur de palette pour un ton sémantique (ok = accent : le rouge est réservé au critique). */
export function toneColor(palette: Palette, tone: "ok" | "accent" | "warn" | "critical" | "muted"): THREE.Color {
  return palette[tone === "ok" ? "accent" : tone];
}

function Ready({ onReady }: { onReady: () => void }) {
  useEffect(onReady, [onReady]);
  return null;
}

/**
 * Plafonne la cadence d'une scène (frameloop "demand" + invalidation régulière) : une
 * scène qui ne fait que pulser n'a pas besoin de 60 images/s. Arrêté hors écran.
 */
function FrameLimiter({ fps }: { fps: number }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    const id = window.setInterval(() => invalidate(), 1000 / fps);
    return () => window.clearInterval(id);
  }, [fps, invalidate]);
  return null;
}

// ─────────────────────────────── scène standard
interface StageProps {
  /** Affiche Blender (public/models/<nom>_poster.png). */
  poster: string;
  /** Description accessible de la visualisation. */
  label: string;
  /** Caméra du widget (drei OrthographicCamera / PerspectiveCamera avec makeDefault). */
  camera: ReactNode;
  children: ReactNode;
  bloomIntensity?: number;
  /** Cadence maximale (images/s). Scènes peu animées : 24-30 ; orbites/rotation : 45-60. */
  fps?: number;
}

export function Stage({ poster, label, camera, children, bloomIntensity = 0.9, fps = 30 }: StageProps) {
  const wrap = useRef<HTMLDivElement>(null);
  const [webgl] = useState(supportsWebGL);
  const [ready, setReady] = useState(false);
  const palette = usePalette();
  const reduced = usePrefersReducedMotion();
  const active = useActive(wrap);
  const markReady = useCallback(() => setReady(true), []);

  return (
    <div ref={wrap} className="relative h-full w-full" role="img" aria-label={label}>
      <ScenePoster src={poster} hidden={ready} />
      {webgl && (
        <SceneBoundary>
          <div className={`absolute inset-0 transition-opacity duration-700 ${ready ? "opacity-100" : "opacity-0"}`}>
            {/* Perf : densité plafonnée à 1.25 (4 scènes à l'écran), GPU performant plutôt que
                la puce intégrée, rendu à la demande cadencé par FrameLimiter. L'anticrénelage
                natif est inutile sous EffectComposer : on applique SMAA (bien moins cher que MSAA). */}
            <Canvas
              dpr={[1, 1.25]}
              frameloop={active ? "demand" : "never"}
              gl={{ antialias: false, powerPreference: "high-performance", stencil: false }}
            >
              <SceneContext.Provider value={{ palette, animate: !reduced }}>
                {active && <FrameLimiter fps={fps} />}
                {camera}
                {/* Fond = var(--surface) du panneau : aucun raccord visible, et un Bloom fiable. */}
                <color attach="background" args={[palette.surface]} />
                {/* Studio DeTecTX (repris des rendus Blender, Y en haut). */}
                <ambientLight intensity={0.25} />
                <directionalLight position={[3.5, 5, 3]} intensity={1.6} color="#e6edf5" />
                <directionalLight position={[-3.5, 1.6, -2.5]} intensity={0.9} color="#10b981" />
                <directionalLight position={[2.5, 1.4, -3.5]} intensity={1.3} color="#22d3ee" />
                {/* Reflets du métal : environnement généré localement (aucun HDR téléchargé). */}
                <Environment resolution={64} environmentIntensity={0.35}>
                  <Lightformer form="rect" intensity={2} position={[0, 4, -3]} scale={[8, 1.5, 1]} />
                  <Lightformer form="rect" intensity={1} position={[-4, 2, 2]} scale={[1.5, 6, 1]} color="#22d3ee" />
                </Environment>
                <Suspense fallback={null}>
                  {children}
                  <Ready onReady={markReady} />
                </Suspense>
                {/* Bloom à demi-résolution : le halo est flou par nature, la différence est invisible. */}
                <EffectComposer multisampling={0}>
                  <Bloom mipmapBlur levels={5} resolutionScale={0.5} luminanceThreshold={1} luminanceSmoothing={0.2} intensity={bloomIntensity} />
                  <ToneMapping mode={ToneMappingMode.NEUTRAL} />
                  <SMAA />
                </EffectComposer>
              </SceneContext.Provider>
            </Canvas>
          </div>
        </SceneBoundary>
      )}
    </div>
  );
}
