"use client";

/**
 * « Radar des menaces » 3D (page Alertes). Le poste au centre ; autour, 15 secteurs = les
 * tactiques ATT&CK dans l'ordre de la kill chain (avant-gauche -> arrière -> avant-droit).
 * Un cristal par DOSSIER (alertes d'une même règle) :
 *   secteur = tactique ; distance au poste = ancienneté de la dernière occurrence (anneaux
 *   1 h, 24 h, 7 j, 30 j : plus c'est près, plus c'est récent) ; hauteur = risque ;
 *   couleur = sévérité ; anneau au sol = nombre d'occurrences. Dossier clos = gris.
 * Le tracé lumineux relie les dossiers ouverts dans l'ordre de leur première apparition
 * (chronologie, pas une causalité prouvée). Le balayage fait briller ce qu'il survole.
 *
 * Modèle généré par Blender (assets/3d/build_radar.py -> public/models/radar.glb).
 * Contrat : Sector_00..14 / SectorMark_00..14 (userData.sector_index), Radar_Sweep,
 * MAT_Sector, MAT_SectorMark, MAT_RadarRim, MAT_RadarCore ; constantes dans lib/cases.ts (RADAR).
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { AlertCase } from "@/lib/api";
import { isOpen, RADAR, radarLayout, sectorAngle, SEVERITY_RANK, type RadarNode, type Severity } from "@/lib/cases";
import { TACTICS } from "@/lib/mitre";
import { FitCamera, ringPoints, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/radar.glb";
useGLTF.preload(MODEL_URL);

const { GROUND_TOP, OUTER_R, RING_R, RING_LABEL, SECTORS, START } = RADAR;
const MAX_NODES = 300;
const SWEEP_SPEED = 0.7; // rad/s
const LABEL_R = OUTER_R + 0.5;

export interface RadarHover {
  ruleId: string;
  x: number;
  y: number;
}

export interface ThreatRadarProps {
  cases: AlertCase[];
  now: number;
  selected: string | null;
  onHover?: (hover: RadarHover | null) => void;
  onSelect?: (ruleId: string | null) => void;
}

function severityColor(palette: Palette, severity: Severity): THREE.Color {
  return severity === "critical" ? palette.critical : severity === "high" ? palette.warn : severity === "medium" ? palette.accent : palette.muted;
}
const TONE_CLASS: Record<Severity, string> = { critical: "text-critical", high: "text-warn", medium: "text-accent", low: "text-muted" };

// Enveloppe : étiquettes des secteurs autour du plateau + cristaux les plus hauts.
const VIEW_POINTS = [...ringPoints(LABEL_R + 0.35, GROUND_TOP), ...ringPoints(OUTER_R, GROUND_TOP + 1.35, 16)];

/** Panneau large : vue plus rasante (le disque devient une ellipse qui occupe la largeur). */
function RadarCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 2;
  const direction: [number, number, number] = aspect > 2.6 ? [0, 0.46, 0.89] : aspect > 1.8 ? [0, 0.56, 0.83] : [0, 0.7, 0.72];
  return <FitCamera points={VIEW_POINTS} direction={direction} fov={30} margin={0.03} />;
}

interface Rig {
  root: THREE.Object3D;
  sweep: THREE.Object3D | null;
  floors: (THREE.MeshStandardMaterial | null)[];
  marks: (THREE.MeshStandardMaterial | null)[];
  rim: THREE.MeshStandardMaterial | null;
  core: THREE.MeshStandardMaterial | null;
  owned: THREE.Material[];
}

/** Clone du modèle avec un matériau par secteur (teinte selon l'activité de la tactique). */
function useRig(scene: THREE.Object3D): Rig {
  return useMemo(() => {
    const root = scene.clone(true);
    const rig: Rig = { root, sweep: null, floors: Array(SECTORS).fill(null), marks: Array(SECTORS).fill(null), rim: null, core: null, owned: [] };
    const shared = new Map<string, THREE.MeshStandardMaterial>();
    root.traverse((obj) => {
      if (obj.name === "Radar_Sweep") rig.sweep = obj;
      if (!(obj instanceof THREE.Mesh)) return;
      const mat = obj.material as THREE.MeshStandardMaterial;
      const index: unknown = obj.userData.sector_index ?? obj.parent?.userData.sector_index;
      if (typeof index === "number" && (mat.name === "MAT_Sector" || mat.name === "MAT_SectorMark")) {
        const own = mat.clone();
        obj.material = own;
        rig.owned.push(own);
        (mat.name === "MAT_Sector" ? rig.floors : rig.marks)[index] = own;
      } else if (mat.name === "MAT_RadarRim" || mat.name === "MAT_RadarCore") {
        let own = shared.get(mat.name);
        if (!own) {
          own = mat.clone();
          shared.set(mat.name, own);
          rig.owned.push(own);
        }
        obj.material = own;
        if (mat.name === "MAT_RadarRim") rig.rim = own;
        else rig.core = own;
      }
    });
    return rig;
  }, [scene]);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const TWO_PI = Math.PI * 2;

function RadarModel({ cases, now, selected, onHover, onSelect }: ThreatRadarProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useRig(scene);
  const live = useRef<Rig | null>(null);
  const hovered = useRef<string | null>(null);

  const stems = useRef<THREE.InstancedMesh>(null);
  const crystals = useRef<THREE.InstancedMesh>(null);
  const bases = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const pulses = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.Mesh>(null);

  const nodes = useMemo(() => radarLayout(cases.slice(0, MAX_NODES), now), [cases, now]);

  // Sévérité la plus grave des dossiers OUVERTS par secteur (teinte du secteur et de son étiquette).
  const sectorWorst = useMemo(() => {
    const worst: (Severity | null)[] = Array(SECTORS).fill(null);
    for (const n of nodes) {
      if (!isOpen(n.c)) continue;
      const prev = worst[n.sector];
      if (!prev || SEVERITY_RANK[n.c.severity] > SEVERITY_RANK[prev]) worst[n.sector] = n.c.severity;
    }
    return worst;
  }, [nodes]);
  const posture: Severity | null = useMemo(
    () => sectorWorst.reduce<Severity | null>((w, s) => (s && (!w || SEVERITY_RANK[s] > SEVERITY_RANK[w]) ? s : w), null),
    [sectorWorst],
  );

  // Tracé chronologique des dossiers ouverts (première apparition), en arcs au ras du sol.
  const path = useMemo(() => {
    const chain = nodes.filter((n) => isOpen(n.c)).sort((a, b) => a.c.first_seen.localeCompare(b.c.first_seen));
    if (chain.length < 2) return null;
    const curve = new THREE.CurvePath<THREE.Vector3>();
    for (let k = 1; k < chain.length; k++) {
      const a = new THREE.Vector3(chain[k - 1].x, GROUND_TOP + 0.03, chain[k - 1].z);
      const b = new THREE.Vector3(chain[k].x, GROUND_TOP + 0.03, chain[k].z);
      const mid = a.clone().lerp(b, 0.5).multiplyScalar(0.78); // arc tiré vers le poste
      mid.y = GROUND_TOP + 0.18 + a.distanceTo(b) * 0.08;
      curve.add(new THREE.QuadraticBezierCurve3(a, mid, b));
    }
    return { curve, geometry: new THREE.TubeGeometry(curve, Math.min(600, chain.length * 40), 0.011, 6, false), segments: chain.length - 1 };
  }, [nodes]);

  const stemGeo = useMemo(() => new THREE.CylinderGeometry(0.007, 0.007, 1, 6).translate(0, 0.5, 0), []);
  const crystalGeo = useMemo(() => new THREE.OctahedronGeometry(1, 0), []);
  const baseGeo = useMemo(() => new THREE.TorusGeometry(1, 0.06, 4, 40).rotateX(Math.PI / 2), []);
  const hitGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const pulseGeo = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const pathMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.85 }), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9 }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.owned.forEach((m) => m.dispose());
    };
  }, [rig]);
  useEffect(() => () => path?.geometry.dispose(), [path]);
  useEffect(
    () => () => {
      [stemGeo, crystalGeo, baseGeo, hitGeo, pulseGeo].forEach((g) => g.dispose());
      [glowMat, hitMat, pathMat, haloMat].forEach((m) => m.dispose());
    },
    [stemGeo, crystalGeo, baseGeo, hitGeo, pulseGeo, glowMat, hitMat, pathMat, haloMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = live.current;
    const head = animate ? (t * SWEEP_SPEED) % TWO_PI : Math.PI;

    if (r) {
      if (r.sweep) r.sweep.rotation.y = -head; // tête du balayage à l'angle `head`
      const postureColor = posture ? severityColor(palette, posture) : palette.accent;
      if (r.rim) {
        r.rim.emissive.copy(postureColor);
        r.rim.emissiveIntensity = posture === "critical" && animate ? 1.8 + 1.2 * (0.5 + 0.5 * Math.sin(t * 3)) : 2.2;
      }
      if (r.core) {
        r.core.emissive.copy(postureColor);
        r.core.emissiveIntensity = 2.4 + (posture === "critical" && animate ? 1.6 * (0.5 + 0.5 * Math.sin(t * 5)) : 0);
      }
      const selSector = nodes.find((n) => n.c.rule_id === selected)?.sector ?? -1;
      for (let i = 0; i < SECTORS; i++) {
        const worst = sectorWorst[i];
        const floor = r.floors[i];
        const mark = r.marks[i];
        const color = worst ? severityColor(palette, worst) : palette.muted;
        if (floor) {
          floor.emissive.copy(color);
          floor.emissiveIntensity = (worst ? 0.1 : 0) + (i === selSector ? 0.14 : 0);
        }
        if (mark) {
          mark.emissive.copy(color);
          mark.emissiveIntensity = worst ? 1.8 : 0.18;
        }
      }
    }

    const st = stems.current;
    const cr = crystals.current;
    const ba = bases.current;
    const hi = hits.current;
    if (!st || !cr || !ba || !hi) return;
    nodes.forEach((n, i) => {
      const open = isOpen(n.c);
      const focus = n.c.rule_id === selected || n.c.rule_id === hovered.current;
      const color = open ? severityColor(palette, n.c.severity) : palette.muted;
      // Le balayage « allume » ce qu'il vient de survoler (traîne de ~0,6 rad).
      const lag = (((head - n.angle) % TWO_PI) + TWO_PI) % TWO_PI;
      const ping = animate && lag < 0.6 ? 1 - lag / 0.6 : 0;
      const size = (open ? 1 : 0.7) * (1 + 0.18 * Math.log2(n.c.count)) * (focus ? 1.35 : 1);
      const top = GROUND_TOP + n.height;

      _q.identity();
      _p.set(n.x, GROUND_TOP, n.z);
      _s.set(1, n.height, 1);
      _m.compose(_p, _q, _s);
      st.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(open ? 0.9 : 0.35);
      st.setColorAt(i, _c);

      _q.setFromAxisAngle(_up, (animate ? t * 0.6 : 0) + i);
      _p.set(n.x, top, n.z);
      _s.set(0.085 * size, 0.14 * size, 0.085 * size);
      _m.compose(_p, _q, _s);
      cr.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(open ? 2.2 + 2.2 * ping + (focus ? 1.5 : 0) : 0.6);
      cr.setColorAt(i, _c);

      _q.identity();
      _p.set(n.x, GROUND_TOP + 0.012, n.z);
      _s.setScalar(0.08 + 0.035 * Math.log2(n.c.count + 1));
      _m.compose(_p, _q, _s);
      ba.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(open ? 1.3 + ping : 0.3);
      ba.setColorAt(i, _c);

      _p.set(n.x, GROUND_TOP, n.z);
      _s.set(0.28, n.height + 0.2, 0.28);
      _m.compose(_p, _q, _s);
      hi.setMatrixAt(i, _m);
    });
    for (const mesh of [st, cr, ba, hi]) {
      mesh.count = nodes.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    hi.computeBoundingSphere();

    // Impulsions qui parcourent le tracé chronologique (sens = ordre d'apparition).
    const pu = pulses.current;
    if (pu) {
      const count = path ? Math.min(12, path.segments * 2) : 0;
      for (let k = 0; k < count; k++) {
        const u = animate ? (t * 0.08 + k / count) % 1 : k / count;
        path!.curve.getPointAt(u, _p);
        _s.setScalar(0.028);
        _q.identity();
        _m.compose(_p, _q, _s);
        pu.setMatrixAt(k, _m);
        _c.copy(posture ? severityColor(palette, posture) : palette.accent).multiplyScalar(3.2);
        pu.setColorAt(k, _c);
      }
      pu.count = count;
      pu.instanceMatrix.needsUpdate = true;
      if (pu.instanceColor) pu.instanceColor.needsUpdate = true;
    }
    pathMat.color.copy(posture ? severityColor(palette, posture) : palette.accent).multiplyScalar(1.4);

    const h = halo.current;
    const sel = selected ? nodes.find((n) => n.c.rule_id === selected) : undefined;
    if (h) {
      h.visible = sel !== undefined;
      if (sel) {
        const k = animate ? 1 + 0.25 * Math.sin(t * 4) : 1.1;
        h.position.set(sel.x, GROUND_TOP + 0.02, sel.z);
        h.scale.setScalar(0.22 * k);
        haloMat.color.copy(isOpen(sel.c) ? severityColor(palette, sel.c.severity) : palette.muted).multiplyScalar(2.6);
      }
    }
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): RadarNode | undefined =>
    e.instanceId === undefined ? undefined : nodes[e.instanceId];

  const selectedNode = selected ? nodes.find((n) => n.c.rule_id === selected) : undefined;
  const ringAngle = START; // les graduations d'ancienneté suivent l'axe avant (entre « Non classé » et « Recon »)

  return (
    <>
      <primitive
        object={rig.root}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.(null);
        }}
      />
      <instancedMesh ref={stems} args={[stemGeo, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={crystals} args={[crystalGeo, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={bases} args={[baseGeo, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={pulses} args={[pulseGeo, glowMat, 12]} frustumCulled={false} raycast={() => null} />
      {path && <mesh geometry={path.geometry} material={pathMat} raycast={() => null} />}
      <mesh ref={halo} material={haloMat} visible={false} raycast={() => null}>
        <torusGeometry args={[1, 0.05, 4, 48]} />
      </mesh>
      <instancedMesh
        ref={hits}
        args={[hitGeo, hitMat, MAX_NODES]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const n = pick(e);
          if (!n) return;
          hovered.current = n.c.rule_id;
          document.body.style.cursor = "pointer";
          onHover?.({ ruleId: n.c.rule_id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const n = pick(e);
          if (n) onSelect?.(n.c.rule_id === selected ? null : n.c.rule_id);
        }}
      />

      {TACTICS.map((tac, i) => {
        const a = sectorAngle(i);
        const worst = sectorWorst[i];
        return (
          <Html key={tac.short} position={[Math.cos(a) * LABEL_R, GROUND_TOP, Math.sin(a) * LABEL_R]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
            <span className={`whitespace-nowrap text-[10px] font-medium ${worst ? TONE_CLASS[worst] : "text-muted opacity-50"}`}>{tac.short}</span>
          </Html>
        );
      })}
      {RING_R.map((r, k) => (
        <Html key={r} position={[Math.cos(ringAngle) * r, GROUND_TOP + 0.02, Math.sin(ringAngle) * r]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <span className="rounded bg-surface/70 px-1 font-mono text-[9px] text-muted">{RING_LABEL[k]}</span>
        </Html>
      ))}
      {selectedNode && (
        <Html position={[selectedNode.x, GROUND_TOP + selectedNode.height + 0.32, selectedNode.z]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
          <span className="max-w-[14rem] truncate whitespace-nowrap rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-fg shadow">
            {selectedNode.c.rule_title}
          </span>
        </Html>
      )}
    </>
  );
}

export default function ThreatRadar(props: ThreatRadarProps) {
  const open = props.cases.filter(isOpen).length;
  return (
    <Stage
      poster="/models/radar_poster.png"
      label={`Radar des menaces : ${props.cases.length} dossier(s) d'alertes, dont ${open} ouvert(s), placés par tactique ATT&CK et par ancienneté`}
      camera={<RadarCamera />}
      fps={30}
    >
      <RadarModel {...props} />
    </Stage>
  );
}
