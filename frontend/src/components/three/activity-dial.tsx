"use client";

/**
 * Cadran 24 h 3D : une colonne lumineuse par tranche horaire, posée à l'heure réelle de
 * sa fenêtre (00 h en haut, sens horaire). Hauteur = volume d'événements ; sommet rouge
 * pulsant si des alertes ont été levées dans la tranche. L'aiguille indique l'heure courante.
 *
 * Modèle généré par Blender (assets/3d/build_dial.py -> public/models/dial.glb).
 * Contrat : Dial_Needle (pointe vers 00 h, origine au centre), MAT_DialRing / MAT_Hub.
 * COLUMN_RADIUS et FLOOR_Y : repris de build_dial.py.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { Stage, useScene } from "./scene-kit";

const MODEL_URL = "/models/dial.glb";
useGLTF.preload(MODEL_URL);

const COLUMN_RADIUS = 1.35;
const FLOOR_Y = 0.085;
const HOUR_MS = 3_600_000;

export interface BucketHover {
  bucket: number;
  x: number;
  y: number;
}

export interface ActivityDialProps {
  /** 24 tranches horaires glissantes, de la plus ancienne (il y a 24 h) à la plus récente. */
  events: number[];
  alerts: number[];
  /** Instant de calcul des tranches (ms) : positionne colonnes et aiguille. */
  now: number;
  onBucketHover?: (hover: BucketHover | null) => void;
  onSelect?: (bucket: number) => void;
}

/** Angle (radians, sens horaire depuis 00 h) d'un instant sur le cadran. */
function clockAngle(ms: number): number {
  const d = new Date(ms);
  return ((d.getHours() + d.getMinutes() / 60) / 24) * Math.PI * 2;
}

interface Rig {
  root: THREE.Object3D;
  needle?: THREE.Object3D;
  hub: THREE.MeshStandardMaterial | null;
  ring: THREE.MeshStandardMaterial | null;
  owned: THREE.Material[];
}

function buildRig(scene: THREE.Group): Rig {
  const root = scene.clone(true);
  const rig: Rig = { root, needle: root.getObjectByName("Dial_Needle"), hub: null, ring: null, owned: [] };
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    if (mat.name === "MAT_Hub" || mat.name === "MAT_DialRing") {
      const m = mat.clone();
      obj.material = m;
      rig.owned.push(m);
      if (mat.name === "MAT_Hub") rig.hub = m;
      else rig.ring = m;
    }
  });
  return rig;
}

function DialCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 36;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Emprise : disque de 4.0 ; en perspective, le bord proche paraît plus grand : on cadre
  // ~2.75 de demi-largeur et ~1.85 de demi-hauteur pour ne jamais rogner le disque.
  const dist = Math.max(2.75 / (Math.tan(half) * aspect), 1.85 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.68, 0.73).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={60}
      position={[dir.x * dist, dir.y * dist, dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0, 0.05)}
    />
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

function DialModel({ events, alerts, now, onBucketHover, onSelect }: ActivityDialProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => buildRig(scene), [scene]);
  const live = useRef<Rig | null>(null);
  const bodies = useRef<THREE.InstancedMesh>(null);
  const caps = useRef<THREE.InstancedMesh>(null);
  const heights = useRef<number[]>(Array(24).fill(0.02));
  const hovered = useRef<number | null>(null);

  // Colonne unitaire dont la base est à l'origine (elle grandit vers le haut).
  const body = useMemo(() => new THREE.BoxGeometry(0.13, 1, 0.2).translate(0, 0.5, 0), []);
  const cap = useMemo(() => new THREE.BoxGeometry(0.15, 0.03, 0.22), []);
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.2 }), []);
  const capMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  const layout = useMemo(() => {
    const max = Math.max(1, ...events);
    return events.map((v, i) => ({
      // Milieu de la tranche i : [now - (24 - i) h, now - (23 - i) h].
      angle: clockAngle(now - (23.5 - i) * HOUR_MS),
      height: v > 0 ? 0.12 + 1.1 * Math.sqrt(v / max) : 0.02,
      active: v > 0,
      alerted: (alerts[i] ?? 0) > 0,
    }));
  }, [events, alerts, now]);
  const needleAngle = clockAngle(now);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.owned.forEach((m) => m.dispose());
    };
  }, [rig]);
  useEffect(
    () => () => {
      body.dispose();
      cap.dispose();
      bodyMat.dispose();
      capMat.dispose();
    },
    [body, cap, bodyMat, capMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const r = live.current;
    const b = bodies.current;
    const c = caps.current;
    if (!r || !b || !c) return;
    const k = 1 - Math.exp(-4 * delta);
    const t = state.clock.elapsedTime;

    if (r.needle) {
      // Plus court chemin angulaire : pas de tour complet à l'envers au passage de minuit.
      const d = -needleAngle - r.needle.rotation.y;
      r.needle.rotation.y += Math.atan2(Math.sin(d), Math.cos(d)) * k;
    }
    r.ring?.emissive.lerp(palette.accent, k);
    if (r.hub) {
      r.hub.emissive.lerp(palette.accent, k);
      r.hub.emissiveIntensity = animate ? 2 + Math.sin(t * 1.6) * 0.6 : 2.2;
    }

    const pulse = animate ? 0.5 + 0.5 * Math.sin(t * 4) : 0.5;
    for (let i = 0; i < layout.length; i++) {
      const col = layout[i];
      const focus = hovered.current === i;
      heights.current[i] += (col.height - heights.current[i]) * k; // croissance douce
      const h = heights.current[i];
      _q.setFromAxisAngle(_up, -col.angle);
      _p.set(Math.sin(col.angle) * COLUMN_RADIUS, FLOOR_Y, -Math.cos(col.angle) * COLUMN_RADIUS);
      _s.set(1, h, 1);
      _m.compose(_p, _q, _s);
      b.setMatrixAt(i, _m);
      _c.copy(col.active ? palette.accent : palette.muted).multiplyScalar(col.active ? (focus ? 0.8 : 0.45) : 0.12);
      b.setColorAt(i, _c);

      _p.y = FLOOR_Y + h + 0.015;
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      c.setMatrixAt(i, _m);
      if (col.alerted) _c.copy(palette.critical).multiplyScalar(2.2 + pulse * 2.2);
      else if (col.active) _c.copy(palette.accent).multiplyScalar(focus ? 4.5 : 2.4);
      else _c.copy(palette.muted).multiplyScalar(0.25);
      c.setColorAt(i, _c);
    }
    b.instanceMatrix.needsUpdate = true;
    c.instanceMatrix.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (c.instanceColor) c.instanceColor.needsUpdate = true;
    b.computeBoundingSphere();
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    hovered.current = e.instanceId;
    document.body.style.cursor = "pointer";
    onBucketHover?.({ bucket: e.instanceId, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onBucketHover?.(null);
  };

  return (
    <>
      <primitive object={rig.root} />
      <instancedMesh
        ref={bodies}
        args={[body, bodyMat, 24]}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onSelect?.(e.instanceId);
        }}
      />
      <instancedMesh ref={caps} args={[cap, capMat, 24]} frustumCulled={false} />
    </>
  );
}

export default function ActivityDial(props: ActivityDialProps) {
  const total = props.events.reduce((s, v) => s + v, 0);
  return (
    <Stage
      poster="/models/dial_poster.png"
      label={`Cadran 24 heures : ${total} événements répartis par heure, aiguille sur l'heure courante`}
      camera={<DialCamera />}
      fps={24}
    >
      <DialModel {...props} />
    </Stage>
  );
}
