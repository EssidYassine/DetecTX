"use client";

/**
 * « Relief de l'activité » 3D : un couloir par journal Windows, le temps s'écoulant de gauche
 * (plus ancien) à droite (maintenant). La hauteur du relief suit le nombre d'événements par
 * heure (échelle logarithmique : un pic de 5 000 n'écrase pas une heure à 12). Les balises
 * rouges ou ambre marquent les heures où le moteur de détection a levé des alertes.
 * Survol = journal + tranche horaire ; clic = filtre la liste sur cette tranche.
 *
 * Modèle généré par Blender (assets/3d/build_relief.py -> public/models/relief.glb).
 * Contrat : MAT_ReliefNow ; TERRAIN_W / LANES / LANE_D / LANE_GAP / TOP_Y / TICKS repris du script.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { EventHistogram } from "@/lib/api";
import { boxPoints, FitCamera, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/relief.glb";
useGLTF.preload(MODEL_URL);

const TERRAIN_W = 7.6;
const LANES = 6;
const LANE_D = 0.62;
const LANE_GAP = 0.08;
const SPAN_D = LANES * LANE_D + (LANES - 1) * LANE_GAP;
const TOP_Y = 0.132;
const TICKS = 8;
const PEAK = 1.05; // hauteur du relief au volume maximal
const SUBDIV = 4; // points intermédiaires par heure (relief lissé)
const MAX_BEACONS = 96;

// Couloir 0 à l'avant (vers la caméra) : Blender -Y -> three +Z.
const laneZ = (i: number) => SPAN_D / 2 - LANE_D / 2 - i * (LANE_D + LANE_GAP);
// Enveloppe : plateau + noms des journaux à gauche (≈ 1 unité) + graduations devant + reliefs.
const VIEW_POINTS = [...boxPoints(TERRAIN_W / 2 + 1.1, SPAN_D / 2 + 0.6, 0, 0.13), ...boxPoints(TERRAIN_W / 2, SPAN_D / 2, TOP_Y, TOP_Y + PEAK + 0.2)];

export interface ReliefLane {
  channel: string;
  label: string;
}

export interface ReliefSlice {
  bin: number;
  channel: string | null; // null = toute la tranche horaire
}

export interface ReliefHover {
  channel: string;
  bin: number;
  x: number;
  y: number;
}

export interface EventReliefProps {
  histogram: EventHistogram;
  lanes: ReliefLane[]; // ordre fixe, de l'avant vers l'arrière
  selected: ReliefSlice | null;
  onHover?: (hover: ReliefHover | null) => void;
  onSelect?: (slice: ReliefSlice | null) => void;
}

function severityColor(palette: Palette, severity: string): THREE.Color {
  return severity === "critical" ? palette.critical : severity === "high" ? palette.warn : palette.accent;
}

/** Catmull-Rom sur des hauteurs régulièrement espacées (relief sans marches). */
function smooth(values: number[], t: number): number {
  const i = Math.floor(t);
  const f = t - i;
  const at = (k: number) => values[Math.min(values.length - 1, Math.max(0, k))];
  const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
  const v = 0.5 * (2 * p1 + (-p0 + p2) * f + (2 * p0 - 5 * p1 + 4 * p2 - p3) * f * f + (-p0 + 3 * p1 - 3 * p2 + p3) * f * f * f);
  return Math.max(0, v);
}

/** Maillage d'un couloir : dessus + jupes avant/arrière, couleurs selon la hauteur. */
function laneGeometry(heights: number[], z: number, low: THREE.Color, high: THREE.Color): THREE.BufferGeometry {
  const n = heights.length;
  const samples = Math.max(2, (n - 1) * SUBDIV + 1);
  const zf = z + LANE_D * 0.43;
  const zb = z - LANE_D * 0.43;
  const positions: number[] = [];
  const colors: number[] = [];
  const index: number[] = [];
  const c = new THREE.Color();
  for (let s = 0; s < samples; s++) {
    const t = (s / (samples - 1)) * (n - 1);
    const h = smooth(heights, t);
    const x = -TERRAIN_W / 2 + ((t + 0.5) / n) * TERRAIN_W;
    const k = Math.min(1, h / PEAK);
    c.copy(low).lerp(high, k).multiplyScalar(0.35 + 1.9 * k * k);
    // 4 sommets par échantillon : dessus avant, dessus arrière, pied avant, pied arrière.
    positions.push(x, TOP_Y + h, zf, x, TOP_Y + h, zb, x, TOP_Y, zf, x, TOP_Y, zb);
    colors.push(c.r, c.g, c.b, c.r * 0.8, c.g * 0.8, c.b * 0.8, low.r * 0.15, low.g * 0.15, low.b * 0.15, low.r * 0.15, low.g * 0.15, low.b * 0.15);
    if (s > 0) {
      const a = (s - 1) * 4;
      const b = s * 4;
      index.push(a, b, a + 1, b, b + 1, a + 1); // dessus
      index.push(a + 2, b + 2, a, b + 2, b, a); // jupe avant
      index.push(a + 1, b + 1, a + 3, b + 1, b + 3, a + 3); // jupe arrière
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute("color", new THREE.Float32BufferAttribute(colors, 3));
  geo.setIndex(index);
  geo.computeBoundingSphere();
  return geo;
}

function binCenterX(bin: number, hours: number): number {
  return -TERRAIN_W / 2 + ((bin + 0.5) / hours) * TERRAIN_W;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function ReliefModel({ histogram, lanes, selected, onHover, onSelect }: EventReliefProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    let now: THREE.MeshStandardMaterial | null = null;
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && (obj.material as THREE.Material).name === "MAT_ReliefNow") {
        now ??= (obj.material as THREE.MeshStandardMaterial).clone();
        obj.material = now;
      }
    });
    return { root, now: now as THREE.MeshStandardMaterial | null };
  }, [scene]);
  const liveNow = useRef<THREE.MeshStandardMaterial | null>(null);
  const beacons = useRef<THREE.InstancedMesh>(null);
  const tops = useRef<THREE.InstancedMesh>(null);
  const slice = useRef<THREE.Mesh>(null);

  const hours = histogram.hours;
  // Hauteurs : échelle log commune à tous les couloirs (comparables entre eux).
  const heights = useMemo(() => {
    const max = Math.max(1, ...lanes.flatMap((l) => histogram.counts[l.channel] ?? [0]));
    const scale = Math.log1p(max);
    return lanes.map((l) => (histogram.counts[l.channel] ?? new Array(hours).fill(0)).map((v) => (v > 0 ? 0.06 + (PEAK - 0.06) * (Math.log1p(v) / scale) : 0.012)));
  }, [histogram, lanes, hours]);

  const surfaces = useMemo(
    () => heights.map((h, i) => laneGeometry(h, laneZ(i), palette.accent.clone().multiplyScalar(0.28), palette.accent)),
    [heights, palette],
  );
  const surfaceMat = useMemo(() => new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, side: THREE.DoubleSide }), []);
  const beaconGeo = useMemo(() => new THREE.CylinderGeometry(0.012, 0.012, 1, 6).translate(0, 0.5, 0), []);
  const sphereGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const sliceMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false }), []);

  const beaconList = useMemo(() => {
    const laneOf = new Map(lanes.map((l, i) => [l.channel, i]));
    return histogram.alerts
      .filter((a) => a.channel !== null && laneOf.has(a.channel))
      .slice(0, MAX_BEACONS)
      .map((a) => {
        const lane = laneOf.get(a.channel as string) as number;
        const h = heights[lane]?.[a.bin] ?? 0;
        return { ...a, lane, x: binCenterX(a.bin, hours), z: laneZ(lane), base: TOP_Y + h };
      });
  }, [histogram.alerts, lanes, heights, hours]);

  useEffect(() => {
    liveNow.current = rig.now;
    return () => {
      liveNow.current = null;
      rig.now?.dispose();
    };
  }, [rig]);
  useEffect(() => () => surfaces.forEach((g) => g.dispose()), [surfaces]);
  useEffect(
    () => () => {
      [beaconGeo, sphereGeo].forEach((g) => g.dispose());
      [surfaceMat, glowMat, sliceMat].forEach((m) => m.dispose());
    },
    [beaconGeo, sphereGeo, surfaceMat, glowMat, sliceMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (liveNow.current) liveNow.current.emissiveIntensity = 1.8 + (animate ? 1.2 * (0.5 + 0.5 * Math.sin(t * 2.4)) : 0.6);
    const b = beacons.current;
    const tp = tops.current;
    if (b && tp) {
      beaconList.forEach((bc, i) => {
        const tall = 0.35 + Math.min(0.45, 0.12 * Math.log1p(bc.count) * 2);
        _p.set(bc.x, bc.base, bc.z);
        _s.set(1, tall, 1);
        _m.compose(_p, _q, _s);
        b.setMatrixAt(i, _m);
        const color = severityColor(palette, bc.severity);
        _c.copy(color).multiplyScalar(2.2);
        b.setColorAt(i, _c);
        const pulse = animate && bc.severity === "critical" ? 0.5 + 0.5 * Math.sin(t * 5 + i) : 0.5;
        _p.y = bc.base + tall;
        _s.setScalar(0.045 + 0.02 * pulse);
        _m.compose(_p, _q, _s);
        tp.setMatrixAt(i, _m);
        _c.copy(color).multiplyScalar(3 + 2 * pulse);
        tp.setColorAt(i, _c);
      });
      [b, tp].forEach((mesh) => {
        mesh.count = beaconList.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
    }
    const sl = slice.current;
    if (sl) {
      sl.visible = selected !== null;
      if (selected) {
        const lane = selected.channel ? lanes.findIndex((l) => l.channel === selected.channel) : -1;
        sl.position.set(binCenterX(selected.bin, hours), TOP_Y + (PEAK + 0.3) / 2, lane >= 0 ? laneZ(lane) : 0);
        sl.scale.set(TERRAIN_W / hours, PEAK + 0.3, lane >= 0 ? LANE_D : SPAN_D);
      }
    }
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): { channel: string; bin: number } | null => {
    const lane: unknown = e.object.userData.lane;
    if (typeof lane !== "number" || !lanes[lane]) return null;
    const bin = Math.min(hours - 1, Math.max(0, Math.floor(((e.point.x + TERRAIN_W / 2) / TERRAIN_W) * hours)));
    return { channel: lanes[lane].channel, bin };
  };

  // Graduations horaires : heure locale, avec le jour quand il change.
  const ticks = useMemo(() => {
    const start = new Date(histogram.start).getTime();
    const dates = Array.from({ length: TICKS + 1 }, (_, k) => new Date(start + (k * hours * 3_600_000) / TICKS));
    const dayOf = (d: Date) => d.toLocaleDateString("fr-FR", { weekday: "short", day: "numeric" });
    const hourOf = (d: Date) => `${String(d.getHours()).padStart(2, "0")}h`;
    return dates.map((at, k) => {
      // Périodes longues : « jour heure » compact ; courtes : l'heure, et le jour quand il change.
      const label = hours > 48 ? `${dayOf(at)} ${hourOf(at)}` : k === 0 || dayOf(at) !== dayOf(dates[k - 1]) ? `${dayOf(at)} ${hourOf(at)}` : hourOf(at);
      // Périodes longues : une graduation sur deux étiquetée (les libellés sont plus longs).
      return { x: -TERRAIN_W / 2 + (k * TERRAIN_W) / TICKS, label: hours > 48 && k % 2 === 1 ? "" : label };
    });
  }, [histogram.start, hours]);

  return (
    <>
      <primitive
        object={rig.root}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.(null);
        }}
      />
      {surfaces.map((geo, i) => (
        <mesh
          key={lanes[i].channel}
          geometry={geo}
          material={surfaceMat}
          userData={{ lane: i }}
          onPointerMove={(e) => {
            e.stopPropagation();
            const hit = pick(e);
            if (!hit) return;
            document.body.style.cursor = "pointer";
            onHover?.({ ...hit, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
          }}
          onPointerOut={() => {
            document.body.style.cursor = "";
            onHover?.(null);
          }}
          onClick={(e) => {
            e.stopPropagation();
            const hit = pick(e);
            if (hit) onSelect?.(selected && selected.bin === hit.bin && selected.channel === hit.channel ? null : hit);
          }}
        />
      ))}
      <instancedMesh ref={beacons} args={[beaconGeo, glowMat, MAX_BEACONS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={tops} args={[sphereGeo, glowMat, MAX_BEACONS]} frustumCulled={false} raycast={() => null} />
      <mesh ref={slice} material={sliceMat} raycast={() => null} visible={false}>
        <boxGeometry args={[1, 1, 1]} />
      </mesh>
      {lanes.map((l, i) => (
        <Html key={l.channel} position={[-TERRAIN_W / 2 - 0.12, TOP_Y, laneZ(i)]} zIndexRange={[4, 0]} style={{ pointerEvents: "none", transform: "translate(-100%, -50%)" }}>
          <span className="whitespace-nowrap text-[10px] font-medium text-muted">{l.label}</span>
        </Html>
      ))}
      {ticks.filter((tk) => tk.label).map((tk) => (
        <Html key={tk.x} position={[tk.x, TOP_Y, SPAN_D / 2 + 0.42]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap font-mono text-[9px] text-muted">{tk.label}</span>
        </Html>
      ))}
    </>
  );
}

export default function EventRelief(props: EventReliefProps) {
  const total = Object.values(props.histogram.counts).reduce((s, v) => s + v.reduce((a, b) => a + b, 0), 0);
  return (
    <Stage
      poster="/models/relief_poster.png"
      label={`Relief de l'activité : ${total} événements sur ${props.histogram.hours} h, ${props.histogram.alerts.length} tranche(s) avec alertes`}
      camera={<FitCamera points={VIEW_POINTS} direction={[0, 0.52, 0.85]} fov={30} />}
      fps={24}
    >
      <ReliefModel {...props} />
    </Stage>
  );
}
