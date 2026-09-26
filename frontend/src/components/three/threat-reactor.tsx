"use client";

/**
 * Réacteur de menace 3D : chaque alerte réelle gravite autour du noyau, sur l'orbite
 * de sa sévérité (critique au plus près, plus rapide). Noyau, anneau et colonne prennent
 * la couleur de la posture ; le noyau pulse s'il existe des alertes critiques.
 *
 * Modèle généré par Blender (assets/3d/build_reactor.py -> public/models/reactor.glb).
 * Contrat : Reactor_Core, Reactor_Cage, Reactor_Gimbal_A/B, Reactor_Shell_<sev>
 * (userData.severity), matériaux MAT_ReactorCore / MAT_ReactorRing / MAT_ReactorBeam /
 * MAT_Shell_<sev>. Rayons d'orbite et hauteur du noyau : repris de build_reactor.py.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { Alert } from "@/lib/api";
import type { PostureTone } from "@/lib/posture";
import { Stage, toneColor, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/reactor.glb";
useGLTF.preload(MODEL_URL);

// Repris de assets/3d/build_reactor.py (Z Blender -> Y three.js).
const CORE_Y = 1.0;
const ORBIT_RADII: Record<Alert["severity"], number> = { critical: 1.05, high: 1.35, medium: 1.65, low: 1.95 };
const ORBIT_SPEED: Record<Alert["severity"], number> = { critical: 0.55, high: 0.38, medium: 0.26, low: 0.18 };
const ORB_SIZE: Record<Alert["severity"], number> = { critical: 0.075, high: 0.06, medium: 0.05, low: 0.045 };
const SEVERITY_TONE: Record<Alert["severity"], "critical" | "warn" | "accent" | "muted"> = {
  critical: "critical",
  high: "warn",
  medium: "accent",
  low: "muted",
};

export interface OrbHover {
  alert: Alert;
  x: number;
  y: number;
}

export interface ThreatReactorProps {
  alerts: Alert[];
  posture: PostureTone;
  criticals: number;
  /** Alerte mise en évidence depuis le flux de détections (survol d'une ligne). */
  highlightId: number | null;
  onOrbHover?: (hover: OrbHover | null) => void;
  onSelect?: (alert: Alert) => void;
}

/** Hachage entier -> [0, 1) stable : l'orbite d'une alerte ne change pas d'un rendu à l'autre. */
function hash01(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

interface Orbit {
  radius: number;
  speed: number;
  phase: number;
  tilt: number;
  size: number;
}

function orbitOf(alert: Alert): Orbit {
  return {
    radius: ORBIT_RADII[alert.severity] + (hash01(alert.id + 13) - 0.5) * 0.12,
    speed: ORBIT_SPEED[alert.severity] * (0.85 + hash01(alert.id + 29) * 0.3),
    phase: hash01(alert.id) * Math.PI * 2,
    tilt: (hash01(alert.id + 7) - 0.5) * 0.35,
    size: ORB_SIZE[alert.severity],
  };
}

/** Objets three.js animés impérativement : hors du modèle de données de React. */
interface Rig {
  root: THREE.Object3D;
  core: THREE.MeshStandardMaterial | null;
  postureMats: THREE.MeshStandardMaterial[]; // anneau + colonne
  shells: Partial<Record<Alert["severity"], THREE.MeshStandardMaterial>>;
  spinners: { cage?: THREE.Object3D; a?: THREE.Object3D; b?: THREE.Object3D };
  owned: THREE.Material[]; // clones propres au composant (les seuls à libérer au démontage)
  scratch: THREE.Color;
}

function buildRig(scene: THREE.Group): Rig {
  const root = scene.clone(true);
  const rig: Rig = { root, core: null, postureMats: [], shells: {}, spinners: {}, owned: [], scratch: new THREE.Color() };
  const cloned = new Map<string, THREE.MeshStandardMaterial>();
  const own = (mat: THREE.MeshStandardMaterial) => {
    let c = cloned.get(mat.name);
    if (!c) {
      c = mat.clone();
      cloned.set(mat.name, c);
    }
    return c;
  };
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    if (mat.name === "MAT_ReactorCore") {
      const m = own(mat);
      obj.material = m;
      rig.core = m;
    } else if (mat.name === "MAT_ReactorRing" || mat.name === "MAT_ReactorBeam") {
      const m = own(mat);
      obj.material = m;
      if (!rig.postureMats.includes(m)) rig.postureMats.push(m);
    } else if (mat.name.startsWith("MAT_Shell_")) {
      const m = own(mat);
      obj.material = m;
      rig.shells[mat.name.slice("MAT_Shell_".length) as Alert["severity"]] = m;
    }
  });
  rig.owned = Array.from(cloned.values());
  rig.spinners = {
    cage: root.getObjectByName("Reactor_Cage"),
    a: root.getObjectByName("Reactor_Gimbal_A"),
    b: root.getObjectByName("Reactor_Gimbal_B"),
  };
  return rig;
}

/** Caméra perspective reculée juste assez pour que les orbites tiennent dans le panneau. */
function ReactorCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 34;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Emprise de la scène : ~4.4 de large (orbite externe + sphères), ~3.1 de haut.
  const distW = 2.2 / (Math.tan(half) * aspect);
  const distH = 1.55 / Math.tan(half);
  const dist = Math.max(distW, distH);
  const dir = new THREE.Vector3(0, 0.48, 0.88).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={60}
      position={[dir.x * dist, CORE_Y * 0.85 + dir.y * dist, dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, CORE_Y * 0.85, 0)}
    />
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function severityColor(palette: Palette, sev: Alert["severity"]): THREE.Color {
  return palette[SEVERITY_TONE[sev]];
}

function ReactorModel({ alerts, posture, criticals, highlightId, onOrbHover, onSelect }: ThreatReactorProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => buildRig(scene), [scene]);
  const live = useRef<Rig | null>(null);
  const orbsRef = useRef<THREE.InstancedMesh>(null);
  const hovered = useRef<number | null>(null);
  const clock = useRef(0);

  const orbits = useMemo(() => alerts.map(orbitOf), [alerts]);
  const counts = useMemo(() => {
    const c: Record<Alert["severity"], number> = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const a of alerts) c[a.severity] += 1;
    return c;
  }, [alerts]);
  const geometry = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const material = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.owned.forEach((m) => m.dispose());
    };
  }, [rig]);
  useEffect(() => () => {
    geometry.dispose();
    material.dispose();
  }, [geometry, material]);
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const r = live.current;
    const orbs = orbsRef.current;
    if (!r) return;
    if (animate) clock.current += delta;
    const t = clock.current;
    const k = 1 - Math.exp(-4 * delta);
    const target = r.scratch;

    // Noyau / anneau / colonne : couleur de la posture ; le noyau bat s'il y a du critique.
    target.copy(toneColor(palette, posture));
    const alarm = criticals > 0;
    const beat = alarm && animate ? 0.5 + 0.5 * Math.sin(state.clock.elapsedTime * 3.2) : 0.5;
    if (r.core) {
      r.core.emissive.lerp(target, k);
      r.core.emissiveIntensity = alarm ? 1.1 + beat * 1.4 : 1.3;
    }
    r.postureMats.forEach((m) => {
      m.emissive.lerp(target, k);
      m.emissiveIntensity = alarm ? 1.6 + beat * 1.2 : 2.2;
    });
    // Orbites : couleur de la sévérité, éteintes si aucune alerte de ce niveau.
    (Object.keys(r.shells) as Alert["severity"][]).forEach((sev) => {
      const m = r.shells[sev];
      if (!m) return;
      m.emissive.lerp(severityColor(palette, sev), k);
      m.emissiveIntensity += ((counts[sev] > 0 ? 1.1 : 0.12) - m.emissiveIntensity) * k;
    });
    // Mécanique : cage et cardans tournent lentement.
    if (animate) {
      r.spinners.cage?.rotateY(delta * 0.12);
      r.spinners.a?.rotateOnWorldAxis(THREE.Object3D.DEFAULT_UP, delta * 0.35);
      r.spinners.b?.rotateX(delta * 0.28);
    }

    // Sphères d'alertes : position sur orbite inclinée, couleur HDR (-> Bloom).
    if (!orbs) return;
    for (let i = 0; i < orbits.length; i++) {
      const o = orbits[i];
      const a = o.phase + o.speed * t;
      const x = o.radius * Math.cos(a);
      const s = o.radius * Math.sin(a);
      _p.set(x, CORE_Y - s * Math.sin(o.tilt), s * Math.cos(o.tilt));
      const focus = hovered.current === i || alerts[i].id === highlightId;
      const dim = highlightId !== null && !focus;
      _s.setScalar(o.size * (focus ? 1.9 : 1));
      _m.compose(_p, _q, _s);
      orbs.setMatrixAt(i, _m);
      _c.copy(severityColor(palette, alerts[i].severity)).multiplyScalar(focus ? 4.5 : dim ? 0.7 : 2.4);
      orbs.setColorAt(i, _c);
    }
    orbs.instanceMatrix.needsUpdate = true;
    if (orbs.instanceColor) orbs.instanceColor.needsUpdate = true;
    orbs.computeBoundingSphere();
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const i = e.instanceId;
    if (i === undefined || !alerts[i]) return;
    hovered.current = i;
    document.body.style.cursor = "pointer";
    onOrbHover?.({ alert: alerts[i], x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onOrbHover?.(null);
  };

  return (
    <>
      <primitive object={rig.root} />
      {alerts.length > 0 && (
        <instancedMesh
          key={alerts.length}
          ref={orbsRef}
          args={[geometry, material, alerts.length]}
          frustumCulled={false}
          onPointerMove={onMove}
          onPointerOut={onOut}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            if (e.instanceId !== undefined && alerts[e.instanceId]) onSelect?.(alerts[e.instanceId]);
          }}
        />
      )}
    </>
  );
}

export default function ThreatReactor(props: ThreatReactorProps) {
  return (
    <Stage
      poster="/models/reactor_poster.png"
      label={`Réacteur de menace 3D : ${props.alerts.length} alertes en orbite autour du noyau, classées par sévérité`}
      camera={<ReactorCamera />}
      bloomIntensity={1.1}
      fps={45}
    >
      <ReactorModel {...props} />
    </Stage>
  );
}
