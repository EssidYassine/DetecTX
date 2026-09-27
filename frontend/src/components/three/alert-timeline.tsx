"use client";

/**
 * Chronologie 3D des alertes : 30 jours (gauche = ancien, droite = aujourd'hui) sur 4 rangées
 * de sévérité (critique à l'avant). Une tour par (jour, sévérité) ; hauteur = nombre d'alertes.
 * Survol/clic d'une tour = jour + sévérité ; survol/clic d'une colonne = jour entier.
 *
 * Modèle généré par Blender (assets/3d/build_timeline.py -> public/models/timeline.glb).
 * Contrat : MAT_Lane_<sévérité>, Today_Mark ; géométrie : DAYS / SLOT_W / SLOT_GAP / LANE_D /
 * LANE_GAP / TOP_Y repris de build_timeline.py.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Alert, TimelineDay } from "@/lib/api";
import { Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/timeline.glb";
useGLTF.preload(MODEL_URL);

type Severity = Alert["severity"];
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low"]; // de l'avant vers l'arrière

const DAYS = 30;
const SLOT_W = 0.3;
const SLOT_GAP = 0.04;
const LANE_D = 0.42;
const LANE_GAP = 0.06;
const TOP_Y = 0.108;
const SPAN_X = DAYS * SLOT_W + (DAYS - 1) * SLOT_GAP;
const SPAN_Z = SEVERITIES.length * LANE_D + (SEVERITIES.length - 1) * LANE_GAP;
const dayX = (i: number) => -SPAN_X / 2 + SLOT_W / 2 + i * (SLOT_W + SLOT_GAP);
// Blender : critique vers -Y (avant) -> three.js : vers +Z (côté caméra).
const laneZ = (j: number) => SPAN_Z / 2 - LANE_D / 2 - j * (LANE_D + LANE_GAP);

export interface TimelineSelection {
  day: number;
  severity: Severity | null; // null = toute la journée
}

export interface TimelineHover extends TimelineSelection {
  x: number;
  y: number;
}

export interface AlertTimelineProps {
  days: TimelineDay[]; // DAYS jours, du plus ancien au plus récent
  selected: TimelineSelection | null;
  onHover?: (hover: TimelineHover | null) => void;
  onSelect?: (selection: TimelineSelection) => void;
}

function severityColor(palette: Palette, sev: Severity): THREE.Color {
  return sev === "critical" ? palette.critical : sev === "high" ? palette.warn : sev === "medium" ? palette.accent : palette.muted;
}

interface Tower {
  day: number;
  severity: Severity;
  height: number;
}

interface Rig {
  root: THREE.Object3D;
  lanes: Partial<Record<Severity, THREE.MeshStandardMaterial>>;
  owned: THREE.Material[];
}

function buildRig(scene: THREE.Group): Rig {
  const root = scene.clone(true);
  const rig: Rig = { root, lanes: {}, owned: [] };
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    if (mat.name.startsWith("MAT_Lane_")) {
      const m = mat.clone();
      obj.material = m;
      rig.owned.push(m);
      rig.lanes[mat.name.slice("MAT_Lane_".length) as Severity] = m;
    }
  });
  return rig;
}

function TimelineCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 30;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Vue plongeante (~49°) : les 4 rangées de sévérité restent distinctes. En perspective, le bord
  // avant (plus proche) paraît plus large que le plan central : demi-largeur ~6.7 ; en hauteur,
  // profondeur projetée + tours + étiquettes de date ≈ 2.6 (demi : 1.3).
  const dist = Math.max(6.7 / (Math.tan(half) * aspect), 1.3 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.75, 0.66).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={120}
      position={[dir.x * dist, 0.3 + dir.y * dist, 0.35 + dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.3, 0.35)}
    />
  );
}

function dayLabel(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function TimelineModel({ days, selected, onHover, onSelect }: AlertTimelineProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => buildRig(scene), [scene]);
  const live = useRef<Rig | null>(null);
  const bodies = useRef<THREE.InstancedMesh>(null);
  const caps = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const highlight = useRef<THREE.Mesh>(null);
  const heights = useRef<number[]>([]);
  const hovered = useRef<number | null>(null);

  const body = useMemo(() => new THREE.BoxGeometry(0.24, 1, 0.34).translate(0, 0.5, 0), []);
  const cap = useMemo(() => new THREE.BoxGeometry(0.26, 0.025, 0.36), []);
  const hitBox = useMemo(() => new THREE.BoxGeometry(SLOT_W + SLOT_GAP, 0.06, SPAN_Z), []);
  const unitBox = useMemo(() => new THREE.BoxGeometry(1, 1, 1), []); // surlignage : dimensions = échelle
  const bodyMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.2 }), []);
  const capMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  // Zones de survol par jour : présentes pour le raycast, invisibles à l'œil.
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const hlMat = useMemo(
    () => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.12, depthWrite: false, blending: THREE.AdditiveBlending }),
    [],
  );

  const towers = useMemo(() => {
    const max = Math.max(1, ...days.flatMap((d) => SEVERITIES.map((s) => d[s])));
    const list: Tower[] = [];
    days.forEach((d, day) =>
      SEVERITIES.forEach((severity) => {
        if (d[severity] > 0) list.push({ day, severity, height: 0.06 + 1.25 * Math.sqrt(d[severity] / max) });
      }),
    );
    return list;
  }, [days]);

  // Une étiquette par semaine en partant d'aujourd'hui (lisible, jamais serré).
  const labels = useMemo(
    () => days.map((d, i) => ({ i, text: i === days.length - 1 ? "Auj." : dayLabel(d.date) })).filter(({ i }) => (days.length - 1 - i) % 7 === 0),
    [days],
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
      [body, cap, hitBox, unitBox].forEach((g) => g.dispose());
      [bodyMat, capMat, hitMat, hlMat].forEach((m) => m.dispose());
    },
    [body, cap, hitBox, unitBox, bodyMat, capMat, hitMat, hlMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  // Zones de survol : positions fixes, calculées une fois.
  useEffect(() => {
    const h = hits.current;
    if (!h) return;
    for (let i = 0; i < DAYS; i++) {
      _m.makeTranslation(dayX(i), TOP_Y + 0.03, 0);
      h.setMatrixAt(i, _m);
    }
    h.instanceMatrix.needsUpdate = true;
    h.computeBoundingSphere();
  }, []);

  useFrame((state, delta) => {
    const r = live.current;
    if (!r) return;
    const k = 1 - Math.exp(-4 * delta);
    const pulse = animate ? 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 4) : 0.5;

    (Object.keys(r.lanes) as Severity[]).forEach((sev) => r.lanes[sev]?.emissive.lerp(severityColor(palette, sev), k));

    // Surlignage de la sélection (colonne entière ou case jour × sévérité).
    const hl = highlight.current;
    if (hl) {
      hl.visible = selected !== null;
      if (selected) {
        const j = selected.severity ? SEVERITIES.indexOf(selected.severity) : -1;
        hl.position.set(dayX(selected.day), TOP_Y + 0.9, j >= 0 ? laneZ(j) : 0);
        hl.scale.set(SLOT_W + SLOT_GAP, 1.8, j >= 0 ? LANE_D + LANE_GAP : SPAN_Z + 0.1);
        (hl.material as THREE.MeshBasicMaterial).color.copy(palette.accent);
      }
    }

    const b = bodies.current;
    const c = caps.current;
    if (!b || !c) return;
    for (let i = 0; i < towers.length; i++) {
      const tw = towers[i];
      const j = SEVERITIES.indexOf(tw.severity);
      const focus = hovered.current === i;
      const prev = heights.current[i] ?? 0.02;
      heights.current[i] = prev + (tw.height - prev) * k;
      const h = heights.current[i];
      const color = severityColor(palette, tw.severity);
      _p.set(dayX(tw.day), TOP_Y, laneZ(j));
      _s.set(1, h, 1);
      _m.compose(_p, _q, _s);
      b.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(focus ? 0.75 : 0.4);
      b.setColorAt(i, _c);

      _p.y = TOP_Y + h + 0.013;
      _s.set(1, 1, 1);
      _m.compose(_p, _q, _s);
      c.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(focus ? 4.5 : tw.severity === "critical" ? 2.2 + pulse * 1.8 : 2.4);
      c.setColorAt(i, _c);
    }
    b.instanceMatrix.needsUpdate = true;
    c.instanceMatrix.needsUpdate = true;
    if (b.instanceColor) b.instanceColor.needsUpdate = true;
    if (c.instanceColor) c.instanceColor.needsUpdate = true;
    b.computeBoundingSphere();
  });

  const emit = (e: ThreeEvent<PointerEvent>, sel: TimelineSelection) => {
    document.body.style.cursor = "pointer";
    onHover?.({ ...sel, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onTowerMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation(); // la tour (plus proche) a priorité sur la colonne
    const tw = e.instanceId !== undefined ? towers[e.instanceId] : undefined;
    if (!tw) return;
    hovered.current = e.instanceId ?? null;
    emit(e, { day: tw.day, severity: tw.severity });
  };
  const onDayMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    if (e.instanceId === undefined) return;
    hovered.current = null;
    emit(e, { day: e.instanceId, severity: null });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.(null);
  };

  return (
    <>
      <primitive object={rig.root} />
      <instancedMesh
        ref={hits}
        args={[hitBox, hitMat, DAYS]}
        frustumCulled={false}
        onPointerMove={onDayMove}
        onPointerOut={onOut}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          if (e.instanceId !== undefined) onSelect?.({ day: e.instanceId, severity: null });
        }}
      />
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
              const tw = e.instanceId !== undefined ? towers[e.instanceId] : undefined;
              if (tw) onSelect?.({ day: tw.day, severity: tw.severity });
            }}
          />
          <instancedMesh key={`c${towers.length}`} ref={caps} args={[cap, capMat, towers.length]} frustumCulled={false} />
        </>
      )}
      <mesh ref={highlight} geometry={unitBox} material={hlMat} visible={false} />
      {labels.map(({ i, text }) => (
        <Html key={i} position={[dayX(i), TOP_Y, SPAN_Z / 2 + 0.45]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap font-mono text-[10px] text-muted">{text}</span>
        </Html>
      ))}
    </>
  );
}

export default function AlertTimeline(props: AlertTimelineProps) {
  const total = props.days.reduce((s, d) => s + d.critical + d.high + d.medium + d.low, 0);
  return (
    <Stage
      poster="/models/timeline_poster.png"
      label={`Chronologie 3D des alertes sur ${props.days.length} jours : ${total} alertes, une tour par jour et par sévérité`}
      camera={<TimelineCamera />}
      fps={24}
    >
      <TimelineModel {...props} />
    </Stage>
  );
}
