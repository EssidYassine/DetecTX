"use client";

/**
 * Emblème 3D de la barre latérale : le « cristal » du poste. Il tourne lentement, prend la
 * couleur de la posture globale, et son cœur bat plus vite quand une alerte critique est ouverte.
 *
 * Scène volontairement LÉGÈRE (présente sur toutes les pages) : pas de post-traitement ni
 * d'environnement, fond transparent, 20 images/s au plus, arrêtée hors écran / onglet caché.
 * Les matériaux émissifs sont non tonemappés : ils « brillent » sans passe Bloom.
 *
 * Modèle généré par Blender (assets/3d/build_emblem.py -> public/models/emblem.glb).
 * Contrat : Emblem_Gem, Emblem_Edges, Emblem_Core, Emblem_Ring ; MAT_EmblemGlass / Edge / Core / Ring.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { Suspense, useEffect, useMemo, useRef } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { PostureTone } from "@/lib/api";
import { useActive, usePalette, usePrefersReducedMotion, type Palette } from "./scene-kit";

const MODEL_URL = "/models/emblem.glb";
useGLTF.preload(MODEL_URL);

const WARM = new THREE.Color("#fbbf77");
const FPS = 20;

function toneColor(palette: Palette, tone: PostureTone): THREE.Color {
  return tone === "critical" ? palette.critical : tone === "warn" ? palette.warn : tone === "ok" ? palette.accent : palette.muted;
}

interface Rig {
  root: THREE.Object3D;
  core: THREE.Object3D | null;
  mats: Record<"glass" | "edge" | "core" | "ring", THREE.MeshStandardMaterial | null>;
}

function Model({ tone, critical, animate, palette }: { tone: PostureTone; critical: boolean; animate: boolean; palette: Palette }) {
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo<Rig>(() => {
    const root = scene.clone(true);
    const out: Rig = { root, core: null, mats: { glass: null, edge: null, core: null, ring: null } };
    const slot: Record<string, keyof Rig["mats"]> = { MAT_EmblemGlass: "glass", MAT_EmblemEdge: "edge", MAT_EmblemCore: "core", MAT_EmblemRing: "ring" };
    root.traverse((obj) => {
      if (obj.name === "Emblem_Core") out.core = obj;
      if (!(obj instanceof THREE.Mesh)) return;
      const key = slot[(obj.material as THREE.Material).name];
      if (!key) return;
      out.mats[key] ??= (obj.material as THREE.MeshStandardMaterial).clone();
      out.mats[key]!.toneMapped = false;
      obj.material = out.mats[key]!;
    });
    return out;
  }, [scene]);
  const live = useRef<Rig | null>(null);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      Object.values(rig.mats).forEach((m) => m?.dispose());
    };
  }, [rig]);

  useFrame((state) => {
    const r = live.current;
    if (!r) return;
    const t = state.clock.elapsedTime;
    const color = toneColor(palette, tone);
    // L'export glTF convertit déjà Z-haut (Blender) en Y-haut : on fait tourner l'ensemble, l'anneau garde son inclinaison.
    r.root.rotation.y = animate ? t * 0.45 : 0.4;
    const beat = critical ? 2.4 : tone === "warn" ? 1.2 : 0.7;
    const pulse = animate ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * beat) : 0.6;
    if (r.core) r.core.scale.setScalar(1 + 0.18 * pulse);
    const { glass, edge, core, ring } = r.mats;
    if (glass) {
      glass.color.copy(color);
      glass.emissive.copy(color);
      glass.emissiveIntensity = 0.35;
    }
    if (edge) {
      edge.emissive.copy(color);
      edge.emissiveIntensity = 1.6 + 0.6 * pulse;
    }
    if (ring) {
      ring.emissive.copy(color);
      ring.emissiveIntensity = 1.1;
    }
    if (core) {
      core.emissive.copy(WARM).lerp(color, critical ? 0.6 : 0.2);
      core.emissiveIntensity = 2.2 + 1.6 * pulse;
    }
  });

  return <primitive object={rig.root} />;
}

/** Cadence plafonnée : invalide la scène FPS fois par seconde tant qu'elle est active. */
function Ticker({ active }: { active: boolean }) {
  const invalidate = useThree((s) => s.invalidate);
  useEffect(() => {
    if (!active) return;
    const id = window.setInterval(() => invalidate(), 1000 / FPS);
    return () => window.clearInterval(id);
  }, [active, invalidate]);
  return null;
}

export default function Emblem({ tone, critical, label }: { tone: PostureTone; critical: boolean; label: string }) {
  const wrap = useRef<HTMLDivElement>(null);
  const active = useActive(wrap);
  const reduced = usePrefersReducedMotion();
  const palette = usePalette();
  return (
    <div ref={wrap} className="h-full w-full" role="img" aria-label={label}>
      <Canvas dpr={[1, 2]} frameloop={active ? "demand" : "never"} gl={{ antialias: true, alpha: true, powerPreference: "low-power" }}>
        <PerspectiveCamera makeDefault position={[0, 0.35, 3.1]} fov={36} onUpdate={(c) => c.lookAt(0, 0, 0)} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[2, 3, 2]} intensity={1.4} />
        <Ticker active={active} />
        <Suspense fallback={null}>
          <Model tone={tone} critical={critical} animate={!reduced} palette={palette} />
        </Suspense>
      </Canvas>
    </div>
  );
}
