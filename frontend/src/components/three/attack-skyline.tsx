"use client";

/**
 * Skyline MITRE ATT&CK 3D : 15 couloirs (14 tactiques dans l'ordre de la kill chain +
 * « Non classé »), une tour par technique détectée. Hauteur = nombre d'alertes ; couleur =
 * sévérité la plus grave de ses alertes. Couloirs vides sombres = angles morts de détection.
 *
 * Modèle généré par Blender (assets/3d/build_skyline.py -> public/models/skyline.glb).
 * Contrat : Lane_00..14 et LaneMark_00..14 (userData.lane_index), MAT_LaneMark.
 * LANES / LANE_W / LANE_GAP / LANE_TOP_Y : repris de build_skyline.py.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Alert } from "@/lib/api";
import { laneOf, TACTICS, type SkylineTechnique } from "@/lib/mitre";
import { Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/skyline.glb";
useGLTF.preload(MODEL_URL);

const LANES = 15;
const LANE_W = 0.5;
const LANE_GAP = 0.07;
const LANE_TOP_Y = 0.132;
const SPAN = LANES * LANE_W + (LANES - 1) * LANE_GAP;
const MAX_SLOTS = 5;
const laneX = (i: number) => -SPAN / 2 + LANE_W / 2 + i * (LANE_W + LANE_GAP);

export type SkylineHover =
  | { kind: "tech"; tech: SkylineTechnique; x: number; y: number }
  | { kind: "lane"; lane: number; x: number; y: number };

export interface AttackSkylineProps {
  techniques: SkylineTechnique[];
  onHover?: (hover: SkylineHover | null) => void;
  onSelect?: (tech: SkylineTechnique) => void;
}

function severityColor(palette: Palette, sev: Alert["severity"] | null): THREE.Color {
  if (sev === "critical") return palette.critical;
  if (sev === "high") return palette.warn;
  if (sev === "low") return palette.muted;
  return palette.accent;
}

interface Tower {
  tech: SkylineTechnique;
  x: number;
  z: number;
  height: number;
}

interface Rig {
  root: THREE.Object3D;
  marks: THREE.MeshStandardMaterial[]; // indexé par lane_index
}

function buildRig(scene: THREE.Group): Rig {
  const root = scene.clone(true);
  const marks: THREE.MeshStandardMaterial[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    const lane: unknown = obj.userData.lane_index;
    if (mat.name === "MAT_LaneMark" && typeof lane === "number") {
      marks[lane] = mat.clone(); // un repère par couloir : allumé selon l'activité
      obj.material = marks[lane];
    }
  });
  return { root, marks };
}

function SkylineCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 34;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Emprise : plaque de 8.9 (+ étiquettes sur deux rangées) ; hauteur apparente ~3.4 avec les tours.
  const dist = Math.max(4.75 / (Math.tan(half) * aspect), 1.8 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.64, 0.77).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={80}
      position={[dir.x * dist, 0.25 + dir.y * dist, dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.25, 0)}
    />
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function SkylineModel({ techniques, onHover, onSelect }: AttackSkylineProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => buildRig(scene), [scene]);
  const live = useRef<Rig | null>(null);
  const bodies = useRef<THREE.InstancedMesh>(null);
  const caps = useRef<THREE.InstancedMesh>(null);
  const heights = useRef<number[]>([]);
  const hovered = useRef<number | null>(null);

  const body = useMemo(() => new THREE.BoxGeometry(0.34, 1, 0.22).translate(0, 0.5, 0), []);
  const cap = useMemo(() => new THREE.BoxGeometry(0.36, 0.03, 0.24), []);
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.2 }), []);
  const capMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  const { towers, activeLanes } = useMemo(() => {
    const max = Math.max(1, ...techniques.map((t) => t.count));
    const byLane = new Map<number, SkylineTechnique[]>();
    for (const t of techniques) {
      const lane = laneOf(t.tactic);
      byLane.set(lane, [...(byLane.get(lane) ?? []), t]);
    }
    const list: Tower[] = [];
    for (const [lane, techs] of byLane) {
      techs
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_SLOTS)
        .forEach((tech, slot) => {
          list.push({ tech, x: laneX(lane), z: 0.6 - slot * 0.3, height: 0.12 + 1.5 * Math.sqrt(tech.count / max) });
        });
    }
    return { towers: list, activeLanes: new Set(byLane.keys()) };
  }, [techniques]);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.marks.forEach((m) => m.dispose());
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
    if (!r) return;
    const k = 1 - Math.exp(-4 * delta);
    const pulse = animate ? 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 4) : 0.5;

    r.marks.forEach((m, lane) => {
      const on = activeLanes.has(lane);
      m.emissive.lerp(on ? palette.accent : palette.muted, k);
      m.emissiveIntensity += ((on ? 1.8 : 0.12) - m.emissiveIntensity) * k;
    });

    if (!b || !c) return;
    for (let i = 0; i < towers.length; i++) {
      const tw = towers[i];
      const focus = hovered.current === i;
      heights.current[i] = (heights.current[i] ?? 0.02) + (tw.height - (heights.current[i] ?? 0.02)) * k;
      const h = heights.current[i];
      const color = severityColor(palette, tw.tech.worst);
      _p.set(tw.x, LANE_TOP_Y, tw.z);
      _s.set(1, h, 1);
      _m.compose(_p, _q, _s);
      b.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(focus ? 0.75 : 0.4);
      b.setColorAt(i, _c);

      _p.y = LANE_TOP_Y + h + 0.015;
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      c.setMatrixAt(i, _m);
      const boost = tw.tech.worst === "critical" ? 2.2 + pulse * 1.8 : 2.4;
      _c.copy(color).multiplyScalar(focus ? 4.5 : boost);
      c.setColorAt(i, _c);
    }
    b.instanceMatrix.needsUpdate = true;
    c.instanceMatrix.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (c.instanceColor) c.instanceColor.needsUpdate = true;
    b.computeBoundingSphere();
  });

  const onTowerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined || !towers[e.instanceId]) return;
    hovered.current = e.instanceId;
    document.body.style.cursor = "pointer";
    onHover?.({ kind: "tech", tech: towers[e.instanceId].tech, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onLaneMove = (e: ThreeEvent<PointerEvent>) => {
    const lane: unknown = e.object.userData.lane_index;
    if (typeof lane !== "number") return;
    e.stopPropagation();
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.({ kind: "lane", lane, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.(null);
  };

  return (
    <>
      <primitive object={rig.root} onPointerMove={onLaneMove} onPointerOut={onOut} />
      {towers.length > 0 && (
        <>
          <instancedMesh
            key={`b${towers.length}`}
            ref={bodies}
            args={[body, bodyMat, towers.length]}
            frustumCulled={false}
            onPointerMove={onTowerMove}
            onPointerOut={onOut}
            onClick={(e: ThreeEvent<MouseEvent>) => {
              e.stopPropagation();
              if (e.instanceId !== undefined && towers[e.instanceId]) onSelect?.(towers[e.instanceId].tech);
            }}
          />
          <instancedMesh key={`c${towers.length}`} ref={caps} args={[cap, capMat, towers.length]} frustumCulled={false} />
        </>
      )}
      {/* Étiquettes des seules tactiques actives, sur deux rangées alternées (couloirs pairs /
          impairs) : deux couloirs voisins ne se chevauchent jamais. */}
      {[...activeLanes].map((lane) => (
        <Html key={lane} position={[laneX(lane), LANE_TOP_Y, lane % 2 === 0 ? 1.15 : 1.5]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap font-mono text-[9px] uppercase tracking-wide text-accent">{TACTICS[lane].short}</span>
        </Html>
      ))}
    </>
  );
}

export default function AttackSkyline(props: AttackSkylineProps) {
  const lanes = new Set(props.techniques.map((t) => laneOf(t.tactic))).size;
  return (
    <Stage
      poster="/models/skyline_poster.png"
      label={`Skyline MITRE ATT&CK : ${props.techniques.length} techniques détectées sur ${lanes} tactiques`}
      camera={<SkylineCamera />}
      fps={24}
    >
      <SkylineModel {...props} />
    </Stage>
  );
}
