"use client";

/**
 * Ville des processus 3D : un bâtiment par processus.
 *   emprise au sol = mémoire (treemap « squarified »), hauteur = CPU (échelle log,
 *   normalisée par le nombre de cœurs), toit lumineux = seuil de charge,
 *   bâtiment gris = exécutable inaccessible (processus système / droits insuffisants).
 * Les bâtiments glissent vers leur nouvelle place à chaque rafraîchissement.
 *
 * Modèle généré par Blender (assets/3d/build_city.py -> public/models/city.glb).
 * Contrat : GROUND_W / GROUND_D / GROUND_TOP repris de build_city.py.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { ProcInfo } from "@/lib/api";
import { loadTone, machineLoad } from "@/lib/host";
import { squarify } from "@/lib/treemap";
import { Stage, useScene } from "./scene-kit";

const MODEL_URL = "/models/city.glb";
useGLTF.preload(MODEL_URL);

const GROUND_W = 6.0;
const GROUND_D = 3.8;
const GROUND_TOP = 0.13;
const MARGIN = 0.1;
const GAP = 0.05; // rue entre deux bâtiments
export const MAX_BUILDINGS = 60;

/** Hauteur d'un bâtiment : échelle log pour distinguer 0.1 %, 1 % et 50 % de charge. */
const heightOf = (load: number) => 0.06 + 0.85 * Math.log10(1 + load);

export interface ProcessHover {
  pid: number;
  x: number;
  y: number;
}

export interface ProcessCityProps {
  processes: ProcInfo[];
  cpuCount: number;
  selected: number | null; // PID
  highlight: number | null; // PID survolé dans la liste
  onHover?: (hover: ProcessHover | null) => void;
  onSelect?: (pid: number | null) => void;
}

interface Building {
  proc: ProcInfo;
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
  load: number;
}

/** État animé d'un bâtiment, indexé par PID : les bâtiments glissent au lieu de sauter. */
interface Anim {
  x: number;
  z: number;
  w: number;
  d: number;
  h: number;
}

function layout(processes: ProcInfo[], cpuCount: number): Building[] {
  const tiles = squarify(processes.slice(0, MAX_BUILDINGS), (p) => Math.max(p.memory_percent, 0.05), {
    x: -GROUND_W / 2 + MARGIN,
    y: -GROUND_D / 2 + MARGIN,
    w: GROUND_W - 2 * MARGIN,
    h: GROUND_D - 2 * MARGIN,
  });
  return tiles.map((t) => {
    const load = machineLoad(t.item.cpu_percent, cpuCount);
    return {
      proc: t.item,
      x: t.x + t.w / 2,
      z: t.y + t.h / 2,
      w: Math.max(0.02, t.w - GAP),
      d: Math.max(0.02, t.h - GAP),
      h: heightOf(load),
      load,
    };
  });
}

function CityCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 32;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Emprise : plateau 6.4 x 4.2 vu à ~40° + bâtiments les plus hauts (~1.8).
  const dist = Math.max(3.4 / (Math.tan(half) * aspect), 1.85 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.62, 0.78).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={80}
      position={[dir.x * dist, 0.4 + dir.y * dist, 0.1 + dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.4, 0.1)}
    />
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function CityModel({ processes, cpuCount, selected, highlight, onHover, onSelect }: ProcessCityProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const root = useMemo(() => scene.clone(true), [scene]);
  const buildings = useMemo(() => layout(processes, cpuCount), [processes, cpuCount]);
  const bodies = useRef<THREE.InstancedMesh>(null);
  const roofs = useRef<THREE.InstancedMesh>(null);
  const group = useRef<THREE.Group>(null);
  const anim = useRef(new Map<number, Anim>());
  const hovered = useRef<number | null>(null);

  const body = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const roof = useMemo(() => new THREE.BoxGeometry(1, 0.02, 1), []);
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.25 }), []);
  const roofMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  useEffect(
    () => () => {
      body.dispose();
      roof.dispose();
      bodyMat.dispose();
      roofMat.dispose();
    },
    [body, roof, bodyMat, roofMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const b = bodies.current;
    const r = roofs.current;
    if (!b || !r) return;
    const k = 1 - Math.exp(-4 * delta);
    const t = state.clock.elapsedTime;
    if (group.current) group.current.rotation.y = animate ? Math.sin(t * 0.2) * 0.04 : 0;

    const seen = new Set<number>();
    buildings.forEach((bd, i) => {
      const pid = bd.proc.pid;
      seen.add(pid);
      let a = anim.current.get(pid);
      if (!a) {
        a = { x: bd.x, z: bd.z, w: bd.w, d: bd.d, h: 0.01 }; // nouveau processus : il « pousse »
        anim.current.set(pid, a);
      }
      a.x += (bd.x - a.x) * k;
      a.z += (bd.z - a.z) * k;
      a.w += (bd.w - a.w) * k;
      a.d += (bd.d - a.d) * k;
      a.h += (bd.h - a.h) * k;

      const isSelected = selected === pid;
      const focus = isSelected || highlight === pid || hovered.current === pid;
      const lift = isSelected && animate ? 0.03 * (0.5 + 0.5 * Math.sin(t * 5)) : 0;

      _p.set(a.x, GROUND_TOP, a.z);
      _s.set(a.w, a.h + lift, a.d);
      _m.compose(_p, _q, _s);
      b.setMatrixAt(i, _m);
      const opaque = bd.proc.exe === null; // exécutable inaccessible : bâtiment gris
      const tone = palette[loadTone(bd.load)];
      // Corps sombre au repos : seuls les processus actifs (ou survolés) ressortent.
      const busy = Math.min(1, Math.log10(1 + bd.load) / 1.5); // 0 au repos, 1 vers 30 % machine
      _c.copy(opaque ? palette.muted : tone).multiplyScalar(opaque ? 0.14 : focus ? 0.6 : 0.09 + busy * 0.3);
      b.setColorAt(i, _c);

      _p.y = GROUND_TOP + a.h + lift + 0.011;
      _s.set(a.w * 0.84, 1, a.d * 0.84); // toit en retrait : les arêtes du bâtiment restent lisibles
      _m.compose(_p, _q, _s);
      r.setMatrixAt(i, _m);
      // Toit : terne au repos, néon (> seuil du Bloom) dès qu'un processus consomme du CPU.
      const glow = focus ? 4.2 : 0.3 + busy * 2.8;
      _c.copy(opaque ? palette.muted : tone).multiplyScalar(opaque && !focus ? 0.3 : glow);
      r.setColorAt(i, _c);
    });
    b.count = buildings.length;
    r.count = buildings.length;
    b.instanceMatrix.needsUpdate = true;
    r.instanceMatrix.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (r.instanceColor) r.instanceColor.needsUpdate = true;
    b.computeBoundingSphere();
    // Processus disparus : on oublie leur état animé.
    anim.current.forEach((_, pid) => {
      if (!seen.has(pid)) anim.current.delete(pid);
    });
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const bd = e.instanceId === undefined ? undefined : buildings[e.instanceId];
    if (!bd) return;
    hovered.current = bd.proc.pid;
    document.body.style.cursor = "pointer";
    onHover?.({ pid: bd.proc.pid, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.(null);
  };

  const tagged = buildings.filter((bd) => bd.proc.pid === selected || bd.proc.pid === highlight);

  return (
    <group ref={group}>
      <primitive
        object={root}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.(null);
        }}
      />
      <instancedMesh
        ref={bodies}
        args={[body, bodyMat, MAX_BUILDINGS]}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const bd = e.instanceId === undefined ? undefined : buildings[e.instanceId];
          if (bd) onSelect?.(bd.proc.pid);
        }}
      />
      <instancedMesh ref={roofs} args={[roof, roofMat, MAX_BUILDINGS]} frustumCulled={false} raycast={() => null} />
      {tagged.map((bd) => (
        <Html key={bd.proc.pid} position={[bd.x, GROUND_TOP + bd.h + 0.18, bd.z]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap rounded border border-line bg-surface-2/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow">
            {bd.proc.name ?? `PID ${bd.proc.pid}`}
          </span>
        </Html>
      ))}
    </group>
  );
}

export default function ProcessCity(props: ProcessCityProps) {
  const n = Math.min(props.processes.length, MAX_BUILDINGS);
  return (
    <Stage
      poster="/models/city_poster.png"
      label={`Ville des processus 3D : ${n} processus ; emprise au sol = mémoire, hauteur = charge CPU`}
      camera={<CityCamera />}
      fps={30}
    >
      <CityModel {...props} />
    </Stage>
  );
}
