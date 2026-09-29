"use client";

/**
 * « Le Tamis de renseignement » 3D : les indicateurs DU POSTE (IP contactées, empreintes de
 * programmes, domaines vus) tombent de l'entonnoir à travers 4 disques, un par source :
 * listes publiques locales, AbuseIPDB, VirusTotal, MISP/OTX. Un grain reconnu s'arrête et
 * s'allume sur le disque de la source qui le connaît ; les autres rejoignent la vasque
 * (« rien de connu »). Un disque éteint = source non configurée.
 *
 * Modèle généré par Blender (assets/3d/build_sieve.py -> public/models/sieve.glb).
 * Contrat : Layer_00..03 / LayerRim_00..03 (userData.layer_index), MAT_Layer, MAT_LayerRim ;
 * LAYER_Y, LAYER_R, BASIN_Y, BASIN_R, TOP_Y repris du script.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { IntelIndicator, IntelOverview } from "@/lib/api";
import { layerActive, SIEVE_LAYERS } from "@/lib/intel";
import { FitCamera, ringPoints, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/sieve.glb";
useGLTF.preload(MODEL_URL);

const LAYER_Y = [2.55, 1.95, 1.35, 0.75];
const LAYER_TOP = 0.035;
const LAYER_R = 1.55;
const BASIN_Y = 0.12;
const BASIN_R = 1.75;
const TOP_Y = 3.25;
const MAX_GRAINS = 2000;
const LABEL_X = 2.05;

const VIEW_POINTS = [...ringPoints(BASIN_R + 0.35, 0, 24), ...ringPoints(1.0, TOP_Y + 0.4, 12), new THREE.Vector3(LABEL_X + 1.7, 1.5, 0), new THREE.Vector3(-LAYER_R - 0.2, 1.5, 0)];

export interface SieveHover {
  value: string;
  x: number;
  y: number;
}

export interface SieveProps {
  overview: IntelOverview;
  selected: string | null;
  onHover?: (hover: SieveHover | null) => void;
  onSelect?: (value: string) => void;
}

function SieveCamera() {
  return <FitCamera points={VIEW_POINTS} direction={[0, 0.3, 0.95]} fov={30} margin={0.04} />;
}

/** Nombre pseudo-aléatoire stable (0..1) tiré d'une chaîne : position fixe d'un grain. */
function seed(text: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

function grainColor(palette: Palette, it: IntelIndicator): THREE.Color {
  if (it.verdict === "malicious") return palette.critical;
  if (it.verdict === "suspicious") return palette.warn;
  return it.type === "hash" ? palette.muted : palette.accent;
}

interface Grain {
  it: IntelIndicator;
  x: number;
  z: number;
  y: number; // repos
  size: number;
  delay: number; // départ de la chute (s)
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function SieveModel({ overview, selected, onHover, onSelect }: SieveProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    const layers: { disc: THREE.MeshStandardMaterial | null; rim: THREE.MeshStandardMaterial | null }[] = Array.from({ length: 4 }, () => ({ disc: null, rim: null }));
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const index: unknown = obj.userData.layer_index ?? obj.parent?.userData.layer_index;
      const name = (obj.material as THREE.Material).name;
      if (typeof index !== "number" || (name !== "MAT_Layer" && name !== "MAT_LayerRim")) return;
      const own = (obj.material as THREE.MeshStandardMaterial).clone();
      obj.material = own;
      layers[index][name === "MAT_Layer" ? "disc" : "rim"] = own;
    });
    return { root, layers };
  }, [scene]);
  const live = useRef<typeof rig | null>(null);
  const hovered = useRef<string | null>(null);
  const start = useRef<number | null>(null);

  const active = useMemo(() => SIEVE_LAYERS.map((_, i) => layerActive(overview, i)), [overview]);
  const grains = useMemo<Grain[]>(() => {
    const perLayer = [0, 0, 0, 0, 0];
    return overview.indicators.slice(0, MAX_GRAINS).map((it, i) => {
      const caught = it.layer !== null;
      const radius = caught ? LAYER_R - 0.25 : BASIN_R - 0.22;
      const r = 0.18 + Math.sqrt(seed(it.value, 1)) * (radius - 0.18); // répartition uniforme sur le disque
      const a = seed(it.value, 2) * Math.PI * 2;
      const size = caught ? 0.07 : it.type === "hash" ? 0.028 : 0.04;
      const slot = perLayer[caught ? it.layer! : 4]++;
      const y = caught ? LAYER_Y[it.layer!] + LAYER_TOP + size : BASIN_Y + 0.02 + size + (slot % 3) * 0.018; // léger tas dans la vasque
      return { it, x: Math.cos(a) * r, z: Math.sin(a) * r, y, size, delay: Math.min(2.5, i * 0.012) };
    });
  }, [overview.indicators]);
  const caughtCount = useMemo(() => [0, 1, 2, 3].map((l) => overview.indicators.filter((i) => i.layer === l).length), [overview.indicators]);
  const basinCount = overview.indicators.filter((i) => i.layer === null).length;

  const grainMesh = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const sphere = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.layers.forEach((l) => {
        l.disc?.dispose();
        l.rim?.dispose();
      });
    };
  }, [rig]);
  useEffect(
    () => () => {
      sphere.dispose();
      [glowMat, hitMat, haloMat].forEach((m) => m.dispose());
    },
    [sphere, glowMat, hitMat, haloMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    start.current ??= t;
    const since = t - start.current;
    const r = live.current;
    if (r) {
      r.layers.forEach((l, i) => {
        const on = active[i];
        const caught = caughtCount[i] > 0;
        const color = caught ? palette.critical : on ? palette.accent : palette.muted;
        if (l.disc) {
          l.disc.color.copy(color);
          l.disc.emissive.copy(color);
          l.disc.emissiveIntensity = on ? 0.2 : 0.02;
          l.disc.opacity = on ? 0.16 : 0.05;
        }
        if (l.rim) {
          l.rim.emissive.copy(color);
          l.rim.emissiveIntensity = !on ? 0.12 : caught && animate ? 1.8 + 1.2 * (0.5 + 0.5 * Math.sin(t * 4)) : 2.2;
        }
      });
    }

    const gm = grainMesh.current;
    const hi = hits.current;
    if (!gm || !hi) return;
    grains.forEach((g, i) => {
      // Chute : départ de l'entonnoir, accélération douce, léger rebond à l'arrivée.
      let y = g.y;
      let x = g.x;
      let z = g.z;
      if (animate) {
        const k = Math.min(1, Math.max(0, (since - g.delay) / 1.1));
        const ease = k < 1 ? k * k : 1;
        y = TOP_Y + 0.2 + (g.y - TOP_Y - 0.2) * ease;
        const spread = Math.min(1, ease * 1.4); // sort de l'entonnoir puis s'écarte vers sa place
        x = g.x * spread;
        z = g.z * spread;
      }
      const focus = g.it.value === selected || g.it.value === hovered.current;
      _q.identity();
      _p.set(x, y, z);
      _s.setScalar(g.size * (focus ? 1.8 : 1));
      _m.compose(_p, _q, _s);
      gm.setMatrixAt(i, _m);
      const pulse = g.it.verdict !== "unknown" && animate ? 0.5 + 0.5 * Math.sin(t * 4 + i) : 0.5;
      _c.copy(grainColor(palette, g.it)).multiplyScalar(g.it.verdict !== "unknown" ? 2.4 + 2 * pulse : focus ? 2.4 : g.it.type === "hash" ? 0.7 : 1.4);
      gm.setColorAt(i, _c);
      _p.set(g.x, g.y, g.z);
      _s.setScalar(Math.max(0.07, g.size * 1.6));
      _m.compose(_p, _q, _s);
      hi.setMatrixAt(i, _m);
    });
    for (const mesh of [gm, hi]) {
      mesh.count = grains.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    hi.computeBoundingSphere();

    const h = halo.current;
    const sel = selected ? grains.find((g) => g.it.value === selected) : undefined;
    if (h) {
      h.visible = sel !== undefined;
      if (sel) {
        h.position.set(sel.x, sel.y - sel.size * 0.6, sel.z);
        h.scale.setScalar(sel.size * (3 + (animate ? 0.4 * Math.sin(t * 4) : 0)));
        haloMat.color.copy(palette.accent).multiplyScalar(2.4);
      }
    }
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) => (e.instanceId === undefined ? undefined : grains[e.instanceId]);

  return (
    <>
      <primitive object={rig.root} />
      <instancedMesh ref={grainMesh} args={[sphere, glowMat, MAX_GRAINS]} frustumCulled={false} raycast={() => null} />
      <mesh ref={halo} material={haloMat} rotation-x={Math.PI / 2} visible={false} raycast={() => null}>
        <torusGeometry args={[1, 0.08, 4, 32]} />
      </mesh>
      <instancedMesh
        ref={hits}
        args={[sphere, hitMat, MAX_GRAINS]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const g = pick(e);
          if (!g) return;
          hovered.current = g.it.value;
          document.body.style.cursor = "pointer";
          onHover?.({ value: g.it.value, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const g = pick(e);
          if (g) onSelect?.(g.it.value);
        }}
      />
      {SIEVE_LAYERS.map((layer, i) => (
        <Html key={layer.id} position={[LABEL_X, LAYER_Y[i] + 0.02, 0]} zIndexRange={[4, 0]} style={{ pointerEvents: "none", transform: "translateY(-50%)" }}>
          <span className={`whitespace-nowrap text-[11px] ${active[i] ? "text-foreground" : "text-muted opacity-60"}`}>
            <span className="font-medium">{layer.label}</span>
            <span className="ml-1.5 font-mono text-[10px]" style={{ color: caughtCount[i] ? "var(--critical)" : undefined }}>
              {!active[i] ? "non configurée" : caughtCount[i] ? `${caughtCount[i]} prise(s)` : "0 prise"}
            </span>
          </span>
        </Html>
      ))}
      <Html position={[LABEL_X, BASIN_Y + 0.1, 0]} zIndexRange={[4, 0]} style={{ pointerEvents: "none", transform: "translateY(-50%)" }}>
        <span className="whitespace-nowrap text-[11px] text-muted">
          Rien de connu <span className="font-mono text-foreground">{basinCount}</span>
        </span>
      </Html>
    </>
  );
}

export default function Sieve(props: SieveProps) {
  const t = props.overview.totals;
  return (
    <Stage poster="/models/sieve_poster.png" label={`Tamis de renseignement : ${t.indicators} indicateurs du poste, ${t.matches} reconnu(s) par une source`} camera={<SieveCamera />} fps={30}>
      <SieveModel {...props} />
    </Stage>
  );
}
