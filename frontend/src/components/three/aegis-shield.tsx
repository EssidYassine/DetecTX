"use client";

/**
 * « Bouclier vivant » 3D (Overview) : le poste sous un dôme de verre en 5 pétales, un par
 * pilier de posture (Menaces face à la caméra, puis Exposition, Défense, Visibilité, Santé).
 *   couleur du pétale = état du pilier ; opacité = score ; un pilier faible (< 50) s'écarte
 *   du dôme et vacille : la brèche montre où le poste est vulnérable ;
 *   étincelles sur le pétale Menaces = dossiers d'alertes ouverts (couleur = sévérité) ;
 *   le cœur au-dessus du poste respire lentement quand tout va bien, bat plus vite en alerte.
 * Étiquettes cliquables autour du dôme (le verre du premier plan masquerait ceux du fond).
 *
 * Modèle généré par Blender (assets/3d/build_aegis.py -> public/models/aegis.glb).
 * Contrat : Petal_00..04 / PetalRim_00..04 / PetalBase_00..04 (userData.pillar_index),
 * Aegis_Heart, MAT_Petal, MAT_PetalRim, MAT_PetalBase, MAT_AegisHeart ; GROUND_TOP / DOME_R / START repris du script.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Finding, Pillar, PillarKey, PostureTone } from "@/lib/api";
import { PILLAR_ORDER } from "@/lib/posture";
import { FitCamera, ringPoints, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/aegis.glb";
useGLTF.preload(MODEL_URL);

// Repris de assets/3d/build_aegis.py.
const GROUND_TOP = 0.11;
const DOME_R = 1.95;
const START = Math.PI / 2;
const STEP = (2 * Math.PI) / 5;
const PETAL_SPAN = STEP / 2 - 0.1;
const LABEL_R = DOME_R + 0.62;
const MAX_SPARKS = 24;
const WARM = new THREE.Color("#fbbf77");

export interface ShieldHover {
  pillar: PillarKey;
  x: number;
  y: number;
}

export interface AegisShieldProps {
  pillars: Pillar[];
  tone: PostureTone;
  threats: Finding[]; // dossiers ouverts (étincelles sur le pétale Menaces)
  selected: PillarKey | null;
  onHover?: (hover: ShieldHover | null) => void;
  onSelect?: (pillar: PillarKey) => void;
}

function toneColor(palette: Palette, tone: PostureTone): THREE.Color {
  return tone === "ok" ? palette.accent : tone === "warn" ? palette.warn : tone === "critical" ? palette.critical : palette.muted;
}
function levelColor(palette: Palette, level: Finding["level"]): THREE.Color {
  return level === "critical" ? palette.critical : level === "high" || level === "medium" ? palette.warn : palette.accent;
}
const TONE_CLASS: Record<PostureTone, string> = { ok: "text-accent border-accent/40", warn: "text-warn border-warn/50", critical: "text-critical border-critical/60", unknown: "text-muted border-line" };

// Enveloppe : plateau, sommet du dôme, étiquettes autour.
const VIEW_POINTS = [...ringPoints(2.8, 0), ...ringPoints(LABEL_R + 0.3, GROUND_TOP), ...ringPoints(0.6, GROUND_TOP + DOME_R + 0.05, 8)];

function ShieldCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1.4;
  return <FitCamera points={VIEW_POINTS} direction={aspect > 1.9 ? [0, 0.4, 0.92] : [0, 0.5, 0.87]} fov={30} margin={0.04} />;
}

interface PetalRig {
  shells: THREE.Object3D[];
  shellMat: THREE.MeshStandardMaterial | null;
  rimMat: THREE.MeshStandardMaterial | null;
  baseMat: THREE.MeshStandardMaterial | null;
}
interface Rig {
  root: THREE.Object3D;
  petals: PetalRig[];
  heart: THREE.Object3D | null;
  heartMat: THREE.MeshStandardMaterial | null;
  owned: THREE.Material[];
}

function useRig(scene: THREE.Object3D): Rig {
  return useMemo(() => {
    const root = scene.clone(true);
    const rig: Rig = { root, petals: Array.from({ length: 5 }, () => ({ shells: [], shellMat: null, rimMat: null, baseMat: null })), heart: null, heartMat: null, owned: [] };
    const slot = { MAT_Petal: "shellMat", MAT_PetalRim: "rimMat", MAT_PetalBase: "baseMat" } as const;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      const index: unknown = obj.userData.pillar_index ?? obj.parent?.userData.pillar_index;
      if (typeof index === "number" && mat.name in slot) {
        const petal = rig.petals[index];
        const key = slot[mat.name as keyof typeof slot];
        petal[key] ??= mat.clone();
        obj.material = petal[key]!;
        if (key === "shellMat") petal.shells.push(obj);
        if (!rig.owned.includes(petal[key]!)) rig.owned.push(petal[key]!);
      } else if (mat.name === "MAT_AegisHeart") {
        rig.heartMat ??= mat.clone();
        if (!rig.owned.includes(rig.heartMat)) rig.owned.push(rig.heartMat);
        obj.material = rig.heartMat;
        if (obj.name === "Aegis_Heart") rig.heart = obj;
      }
    });
    return rig;
  }, [scene]);
}

/** Lueur chaude au sol (dégradé radial généré localement, aucun fichier). */
function useGlowTexture() {
  return useMemo(() => {
    const c = document.createElement("canvas");
    c.width = c.height = 128;
    const g = c.getContext("2d")!;
    const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
    grad.addColorStop(0, "rgba(255,255,255,1)");
    grad.addColorStop(0.35, "rgba(255,255,255,0.35)");
    grad.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  }, []);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function ShieldModel({ pillars, tone, threats, selected, onHover, onSelect }: AegisShieldProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useRig(scene);
  const live = useRef<Rig | null>(null);
  const hovered = useRef<PillarKey | null>(null);
  const sparks = useRef<THREE.InstancedMesh>(null);
  const glow = useRef<THREE.Mesh>(null);
  const glowTex = useGlowTexture();

  const byKey = useMemo(() => new Map(pillars.map((p) => [p.key, p])), [pillars]);
  const sparkGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const sparkMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ map: glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false }), [glowTex]);

  // Étincelles : positions stables sur la face externe du pétale Menaces (pseudo-aléatoire par dossier).
  const sparkSpots = useMemo(
    () =>
      threats.slice(0, MAX_SPARKS).map((f, i) => {
        const h = [...f.id].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7 + i);
        const phi = START + ((h % 1000) / 1000 - 0.5) * 2 * PETAL_SPAN * 0.8;
        const elev = 0.2 + (((h >>> 10) % 1000) / 1000) * 0.95;
        const r = DOME_R + 0.02;
        return { f, pos: new THREE.Vector3(r * Math.cos(elev) * Math.cos(phi), GROUND_TOP + r * Math.sin(elev), r * Math.cos(elev) * Math.sin(phi)), seed: h % 97 };
      }),
    [threats],
  );

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.owned.forEach((m) => m.dispose());
    };
  }, [rig]);
  useEffect(
    () => () => {
      sparkGeo.dispose();
      sparkMat.dispose();
      glowMat.dispose();
      glowTex.dispose();
    },
    [sparkGeo, sparkMat, glowMat, glowTex],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = live.current;
    if (r) {
      PILLAR_ORDER.forEach((key, i) => {
        const p = byKey.get(key);
        const petal = r.petals[i];
        const ptone = p?.tone ?? "unknown";
        const color = toneColor(palette, ptone);
        const score = p?.score ?? 50;
        const focus = selected === key || hovered.current === key;
        const weak = p?.score !== null && p?.score !== undefined && p.score < 50;
        const flicker = weak && animate ? 0.55 + 0.45 * Math.abs(Math.sin(t * 7 + i * 1.3)) : 1;
        // Brèche : le pétale faible s'écarte du dôme (vers l'extérieur de son secteur).
        const gap = weak ? (1 - score / 50) * 0.22 + 0.04 : 0;
        const phi = START + STEP * i;
        for (const shell of petal.shells) shell.position.set(Math.cos(phi) * gap, 0, Math.sin(phi) * gap);
        if (petal.shellMat) {
          petal.shellMat.color.copy(color);
          petal.shellMat.emissive.copy(color);
          petal.shellMat.emissiveIntensity = 0.12 + (focus ? 0.35 : 0);
          petal.shellMat.opacity = (0.07 + 0.13 * (score / 100)) * flicker + (focus ? 0.06 : 0);
        }
        if (petal.rimMat) {
          petal.rimMat.emissive.copy(color);
          petal.rimMat.emissiveIntensity = (focus ? 3.6 : 2.3) * flicker;
        }
        if (petal.baseMat) {
          petal.baseMat.emissive.copy(color);
          petal.baseMat.emissiveIntensity = (0.5 + 1.5 * (score / 100)) * (focus ? 1.6 : 1);
        }
      });
      // Le cœur : chaud et lent quand tout va bien, rouge et rapide en alerte (double battement).
      const beat = tone === "critical" ? 2.2 : tone === "warn" ? 1.3 : 0.8;
      const phase = animate ? (t * beat) % 1 : 0.5;
      const pulse = tone === "critical" ? Math.max(Math.exp(-((phase - 0.1) ** 2) / 0.004), 0.7 * Math.exp(-((phase - 0.32) ** 2) / 0.004)) : 0.5 + 0.5 * Math.sin(phase * Math.PI * 2);
      if (r.heartMat) {
        r.heartMat.emissive.copy(WARM).lerp(toneColor(palette, tone), tone === "ok" ? 0.15 : 0.55);
        r.heartMat.emissiveIntensity = 3 + 2.2 * pulse;
      }
      if (r.heart) r.heart.scale.setScalar(1 + 0.12 * pulse);
      const g = glow.current;
      if (g) {
        glowMat.color.copy(WARM).lerp(toneColor(palette, tone), 0.3).multiplyScalar(0.28 + 0.14 * pulse);
        g.scale.setScalar(3.4 + 0.25 * pulse);
      }
    }

    const sp = sparks.current;
    if (sp) {
      sparkSpots.forEach((s, i) => {
        const twinkle = animate ? 0.5 + 0.5 * Math.sin(t * 3 + s.seed) : 0.7;
        _q.identity();
        _s.setScalar(0.03 + 0.018 * twinkle + (s.f.level === "critical" ? 0.015 : 0));
        _m.compose(s.pos, _q, _s);
        sp.setMatrixAt(i, _m);
        _c.copy(levelColor(palette, s.f.level)).multiplyScalar(2.4 + 2.2 * twinkle);
        sp.setColorAt(i, _c);
      });
      sp.count = sparkSpots.length;
      sp.instanceMatrix.needsUpdate = true;
      if (sp.instanceColor) sp.instanceColor.needsUpdate = true;
    }
  });

  const pillarOf = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): PillarKey | null => {
    const index: unknown = e.object.userData.pillar_index ?? e.object.parent?.userData.pillar_index;
    return typeof index === "number" ? PILLAR_ORDER[index] : null;
  };

  return (
    <>
      <mesh ref={glow} material={glowMat} rotation-x={-Math.PI / 2} position={[0, GROUND_TOP + 0.015, 0]} raycast={() => null}>
        <planeGeometry args={[1, 1]} />
      </mesh>
      <primitive
        object={rig.root}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          const key = pillarOf(e);
          if (!key) return;
          e.stopPropagation();
          hovered.current = key;
          document.body.style.cursor = "pointer";
          onHover?.({ pillar: key, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          const key = pillarOf(e);
          if (!key) return;
          e.stopPropagation();
          onSelect?.(key);
        }}
      />
      <instancedMesh ref={sparks} args={[sparkGeo, sparkMat, MAX_SPARKS]} frustumCulled={false} raycast={() => null} />
      {PILLAR_ORDER.map((key, i) => {
        const p = byKey.get(key);
        const phi = START + STEP * i;
        const t: PostureTone = p?.tone ?? "unknown";
        return (
          <Html key={key} position={[Math.cos(phi) * LABEL_R, GROUND_TOP, Math.sin(phi) * LABEL_R]} center zIndexRange={[5, 0]}>
            <button
              onClick={() => onSelect?.(key)}
              onMouseEnter={(ev) => {
                hovered.current = key;
                onHover?.({ pillar: key, x: ev.clientX, y: ev.clientY });
              }}
              onMouseLeave={() => {
                hovered.current = null;
                onHover?.(null);
              }}
              className={`flex items-baseline gap-1.5 whitespace-nowrap rounded-full border bg-surface/90 px-2 py-0.5 text-[10px] font-medium shadow transition hover:bg-surface-2 ${TONE_CLASS[t]} ${selected === key ? "ring-1 ring-current" : ""}`}
            >
              {p?.label ?? key}
              <span className="font-mono tabular-nums">{p?.score ?? "—"}</span>
            </button>
          </Html>
        );
      })}
    </>
  );
}

export default function AegisShield(props: AegisShieldProps) {
  const weak = props.pillars.filter((p) => p.tone === "critical" || p.tone === "warn").map((p) => p.label.toLowerCase());
  return (
    <Stage
      poster="/models/aegis_poster.png"
      label={`Bouclier du poste : ${weak.length ? `points faibles — ${weak.join(", ")}` : "tous les piliers sous contrôle"}`}
      camera={<ShieldCamera />}
      fps={30}
    >
      <ShieldModel {...props} />
    </Stage>
  );
}
