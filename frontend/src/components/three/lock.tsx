"use client";

/**
 * « La Serrure » 3D : le durcissement du poste. Une porte de coffre vue de face ; chaque contrôle
 * de durcissement est un PÊNE rayonnant autour du volant : engagé dans le cadre (protégé, accent)
 * ou rétracté vers le centre (à renforcer : ambre, rouge si grave). Grisé = sans objet ou
 * illisible. Le liseré de la porte prend la couleur de la note, affichée au centre.
 *
 * Modèle généré par Blender (assets/3d/build_lock.py -> public/models/lock.glb).
 * Contrat : Lock_Wheel (groupe qui tourne), Bolt_Template (pêne instancié ici, puis masqué),
 * MAT_DoorRim ; BOLT_Y / BOLT_IN / BOLT_OUT repris du script (glTF : la porte regarde +Z).
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { HardeningControl, HardeningSnapshot } from "@/lib/api";
import { GRADE_TONE } from "@/lib/hardening";
import { FitCamera, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/lock.glb";
useGLTF.preload(MODEL_URL);

const BOLT_Z = 0.19; // BOLT_Y Blender (-0.19) -> glTF z
const R_OUT = (1.3 + 1.92) / 2; // centre d'un pêne engagé
const R_IN = (0.86 + 1.48) / 2; // centre d'un pêne rétracté
const R_NA = (R_OUT + R_IN) / 2;
const MAX_BOLTS = 32;
const VIEW_POINTS = Array.from({ length: 32 }, (_, i) => {
  const a = (i / 32) * Math.PI * 2;
  return new THREE.Vector3(Math.cos(a) * 2.4, Math.sin(a) * 2.4, 0.2);
});

export interface LockHover {
  id: string;
  x: number;
  y: number;
}

export interface LockProps {
  snapshot: HardeningSnapshot;
  selected: string | null;
  onHover?: (hover: LockHover | null) => void;
  onSelect?: (id: string) => void;
}

function LockCamera() {
  return <FitCamera points={VIEW_POINTS} direction={[0.12, 0.1, 1]} fov={28} margin={0.04} />;
}

function boltColor(palette: Palette, c: HardeningControl): THREE.Color {
  if (c.state === "ok") return palette.accent;
  if (c.state === "weak") return c.level === "high" ? palette.critical : palette.warn;
  return palette.muted;
}

function boltRadius(c: HardeningControl): number {
  return c.state === "ok" ? R_OUT : c.state === "weak" ? R_IN : R_NA;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const Z = new THREE.Vector3(0, 0, 1);

function LockModel({ snapshot, selected, onHover, onSelect }: LockProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    let wheel: THREE.Object3D | null = null;
    let bolt: THREE.BufferGeometry | null = null;
    let rim: THREE.MeshStandardMaterial | null = null;
    // Le centre du volant porte la note : pastille sombre, pas de lueur derrière la lettre.
    const cap = new THREE.MeshStandardMaterial({ color: 0x0b0f14, metalness: 0.6, roughness: 0.4 });
    root.traverse((obj) => {
      if (obj.name === "Lock_Wheel") wheel = obj;
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.name === "Bolt_Template") {
        bolt = obj.geometry as THREE.BufferGeometry;
        obj.visible = false;
      }
      const mat = obj.material as THREE.MeshStandardMaterial;
      if (obj.name === "Lock_WheelCap") {
        obj.material = cap;
        return;
      }
      if (mat.name === "MAT_DoorRim") {
        rim ??= mat.clone();
        obj.material = rim;
      }
    });
    return { root, wheel: wheel as THREE.Object3D | null, bolt: (bolt as THREE.BufferGeometry | null) ?? new THREE.BoxGeometry(0.62, 0.13, 0.1), rim: rim as THREE.MeshStandardMaterial | null, cap };
  }, [scene]);
  const live = useRef<typeof rig | null>(null);
  const hovered = useRef<string | null>(null);
  const radii = useRef<number[]>([]);

  const controls = useMemo(() => snapshot.controls.slice(0, MAX_BOLTS), [snapshot.controls]);
  const angles = useMemo(() => controls.map((_, i) => Math.PI / 2 - (i / controls.length) * Math.PI * 2), [controls]);
  const gradeTone = GRADE_TONE[snapshot.summary.grade];

  const bolts = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  // Couleur portée par l'instance (intensité > 1 = lueur sous le bloom), comme les grains du tamis.
  const boltMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitGeo = useMemo(() => new THREE.BoxGeometry(0.72, 0.26, 0.3), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.rim?.dispose();
      rig.cap.dispose();
    };
  }, [rig]);
  useEffect(
    () => () => {
      boltMat.dispose();
      hitGeo.dispose();
      hitMat.dispose();
    },
    [boltMat, hitGeo, hitMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const r = live.current;
    if (r?.wheel) {
      // Tour lent au repos ; la position de repos dépend de la note (un coffre bien fermé est « verrouillé »).
      const rest = (-snapshot.summary.score / 100) * Math.PI;
      r.wheel.rotation.z = animate ? rest + Math.sin(t * 0.35) * 0.12 : rest;
    }
    if (r?.rim) {
      r.rim.emissive.copy(palette[gradeTone]);
      r.rim.emissiveIntensity = 2.2;
    }
    const b = bolts.current;
    const h = hits.current;
    if (!b || !h) return;
    const ease = animate ? Math.min(1, delta * 4) : 1;
    controls.forEach((c, i) => {
      const target = boltRadius(c);
      const current = radii.current[i] ?? (animate ? R_IN : target);
      const radius = current + (target - current) * ease;
      radii.current[i] = radius;
      const a = angles[i];
      const focus = c.id === selected || c.id === hovered.current;
      _q.setFromAxisAngle(Z, a);
      _p.set(Math.cos(a) * radius, Math.sin(a) * radius, BOLT_Z + (focus ? 0.06 : 0));
      _s.set(1, focus ? 1.25 : 1, focus ? 1.25 : 1);
      _m.compose(_p, _q, _s);
      b.setMatrixAt(i, _m);
      const weakHigh = c.state === "weak" && c.level === "high";
      const pulse = weakHigh && animate ? 0.5 + 0.5 * Math.sin(t * 3.5 + i) : 0.5;
      const strength = focus ? 2.6 : c.state === "ok" ? 1.1 : c.state === "weak" ? 1.4 + 1.2 * pulse : 0.35;
      _c.copy(boltColor(palette, c)).multiplyScalar(strength);
      b.setColorAt(i, _c);
      _p.set(Math.cos(a) * radius, Math.sin(a) * radius, BOLT_Z);
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      h.setMatrixAt(i, _m);
    });
    for (const m of [b, h]) {
      m.count = controls.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    h.computeBoundingSphere();
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) => (e.instanceId === undefined ? undefined : controls[e.instanceId]);
  const s = snapshot.summary;

  return (
    <>
      <primitive object={rig.root} />
      <instancedMesh ref={bolts} args={[rig.bolt, boltMat, MAX_BOLTS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh
        ref={hits}
        args={[hitGeo, hitMat, MAX_BOLTS]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const c = pick(e);
          if (!c) return;
          hovered.current = c.id;
          document.body.style.cursor = "pointer";
          onHover?.({ id: c.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const c = pick(e);
          if (c) onSelect?.(c.id);
        }}
      />
      <Html position={[0, 0, 0.5]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
        <span className="flex flex-col items-center leading-none">
          <span className="font-display text-6xl font-semibold" style={{ color: `var(--${gradeTone})`, textShadow: "0 0 18px color-mix(in srgb, currentColor 55%, transparent)" }}>
            {s.grade}
          </span>
          <span className="mt-1 font-mono text-[10px] text-muted">
            {s.ok}/{s.total} verrous
          </span>
        </span>
      </Html>
    </>
  );
}

export default function Lock(props: LockProps) {
  const s = props.snapshot.summary;
  return (
    <Stage poster="/models/lock_poster.png" label={`Serrure de durcissement : note ${s.grade} (${s.score}/100), ${s.ok} contrôles sur ${s.total} en place`} camera={<LockCamera />} fps={30}>
      <LockModel {...props} />
    </Stage>
  );
}
