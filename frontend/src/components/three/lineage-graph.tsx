"use client";

/**
 * Lignée 3D d'une application : qui l'a lancée (à gauche), ce qu'elle lance (à droite).
 * Cinq couloirs : grand-parent · parent · APPLICATION · enfants · descendants.
 *   taille du nœud = mémoire, éclat = CPU, anneau cyan = possède une fenêtre (c'est ce
 *   processus qu'on ferme), ambre = indice d'analyse, gris = chemin inaccessible.
 * Les nœuds glissent vers leur place quand on change d'application.
 *
 * Modèle généré par Blender (assets/3d/build_lineage.py -> public/models/lineage.glb).
 * Contrat : Lineage_Lane_0..4 (userData.lane_index) ; LANES_X / TOP_Y repris du script.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { machineLoad } from "@/lib/host";
import { LANE_TITLES, type Lineage, type LineageNode } from "@/lib/lineage";
import { hintsFor } from "@/lib/proctree";
import { Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/lineage.glb";
useGLTF.preload(MODEL_URL);

const LANES_X = [-3.0, -1.5, 0.0, 1.5, 3.0];
const TOP_Y = 0.132;
const NODE_Y = TOP_Y + 0.3;
const Z_BACK = -1.25;
const Z_FRONT = 1.0; // l'avant du plateau porte les chevrons et les titres des couloirs
const MAX_NODES = 64;
const ARC_SEGMENTS = 12;
const WINDOW_COLOR = new THREE.Color("#22d3ee"); // = CYAN de dtx3d

export interface LineageHover {
  key: string;
  x: number;
  y: number;
}

export interface LineageGraphProps {
  lineage: Lineage;
  cpuCount: number;
  focus: number | null; // PID sélectionné
  onHover?: (hover: LineageHover | null) => void;
  onSelect?: (pid: number) => void;
}

/** Position d'un nœud : une colonne par couloir, deux colonnes décalées au-delà de 6 nœuds. */
function slotPosition(lane: number, slot: number, count: number): THREE.Vector3 {
  const split = count > 6;
  const perCol = split ? Math.ceil(count / 2) : count;
  const row = split ? Math.floor(slot / 2) : slot;
  const step = perCol > 1 ? Math.min(0.85, (Z_FRONT - Z_BACK) / (perCol - 1)) : 0;
  const z = (Z_BACK + Z_FRONT) / 2 - (step * (perCol - 1)) / 2 + row * step;
  const x = LANES_X[lane] + (split ? (slot % 2 === 0 ? -0.26 : 0.26) : 0);
  return new THREE.Vector3(x, NODE_Y, z);
}

function nodeColor(palette: Palette, n: LineageNode, hinted: boolean): THREE.Color {
  if (!n.node) return palette.muted;
  if (hinted) return palette.warn;
  if (n.node.proc.exe === null) return palette.muted;
  return n.inApp ? palette.accent : palette.muted;
}

function bezier(out: THREE.Vector3, a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number) {
  const u = 1 - t;
  return out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
}

function LineageCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 30;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Emprise : plateau 8 x 3.9 vu à ~53° + titres des couloirs devant le plateau.
  const dist = Math.max(4.15 / (Math.tan(half) * aspect), 1.8 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.8, 0.6).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={80}
      position={[dir.x * dist, 0.3 + dir.y * dist, 0.25 + dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.3, 0.25)}
    />
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _flat = new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.PI / 2, 0, 0));
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _ctrl = new THREE.Vector3();

function LineageModel({ lineage, cpuCount, focus, onHover, onSelect }: LineageGraphProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const root = useMemo(() => scene.clone(true), [scene]);
  const bodies = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const rings = useRef<THREE.InstancedMesh>(null);
  const pulses = useRef<THREE.InstancedMesh>(null);
  const hovered = useRef<string | null>(null);
  // Position / taille animées par clé : les nœuds glissent au lieu de sauter.
  const anim = useRef(new Map<string, { pos: THREE.Vector3; size: number }>());

  const sphere = useMemo(() => new THREE.IcosahedronGeometry(1, 2), []);
  const torus = useMemo(() => new THREE.TorusGeometry(1, 0.07, 8, 40), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.7, toneMapped: false }), []);

  const layout = useMemo(() => {
    const maxRss = Math.max(1, ...lineage.nodes.map((n) => n.node?.proc.rss ?? 0));
    const byKey = new Map(
      lineage.nodes.map((n) => {
        const rss = n.node?.proc.rss ?? 0;
        return [
          n.key,
          {
            n,
            target: slotPosition(n.lane, n.slot, lineage.slots[n.lane]),
            size: n.node ? 0.06 + 0.1 * Math.sqrt(rss / maxRss) : 0.07,
            load: n.node ? machineLoad(n.node.proc.cpu_percent, cpuCount) : 0,
            hinted: n.node ? hintsFor(n.node).length > 0 : false, // calculé une fois, pas à chaque image
          },
        ];
      }),
    );
    return { list: [...byKey.values()], byKey };
  }, [lineage, cpuCount]);

  const arcs = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const count = Math.max(1, lineage.edges.length) * ARC_SEGMENTS * 2;
    geo.setAttribute("position", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    geo.setDrawRange(0, lineage.edges.length * ARC_SEGMENTS * 2);
    return geo;
  }, [lineage.edges.length]);

  useEffect(() => () => arcs.dispose(), [arcs]);
  useEffect(
    () => () => {
      sphere.dispose();
      torus.dispose();
      glowMat.dispose();
      hitMat.dispose();
      lineMat.dispose();
    },
    [sphere, torus, glowMat, hitMat, lineMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const b = bodies.current;
    const h = hits.current;
    const r = rings.current;
    const pu = pulses.current;
    if (!b || !h || !r || !pu) return;
    const t = state.clock.elapsedTime;
    const k = 1 - Math.exp(-5 * delta);

    const seen = new Set<string>();
    let ringCount = 0;
    layout.list.forEach((item, i) => {
      const { n } = item;
      seen.add(n.key);
      let a = anim.current.get(n.key);
      if (!a) {
        a = { pos: item.target.clone(), size: 0 }; // nouveau nœud : il éclot
        anim.current.set(n.key, a);
      }
      a.pos.lerp(item.target, k);
      a.size += (item.size - a.size) * k;

      const pid = n.node?.proc.pid;
      const isFocus = pid !== undefined && pid === focus;
      const lit = isFocus || n.key === hovered.current;
      const bob = animate ? Math.sin(t * 1.3 + i) * 0.02 : 0;
      _p.copy(a.pos);
      _p.y += bob;
      _s.setScalar(a.size * (isFocus ? 1.35 : 1));
      _m.compose(_p, _q, _s);
      b.setMatrixAt(i, _m);
      _s.setScalar(Math.max(0.16, a.size * 2));
      _m.compose(_p, _q, _s);
      h.setMatrixAt(i, _m);

      const glow = lit ? 3.8 : !n.node ? 0.5 : 0.9 + Math.min(1.8, Math.log10(1 + item.load) * 1.6);
      _c.copy(nodeColor(palette, n, item.hinted)).multiplyScalar(glow);
      b.setColorAt(i, _c);

      // Anneau : ce processus possède une fenêtre.
      if ((n.node?.proc.windows ?? 0) > 0) {
        _s.setScalar(a.size * (isFocus ? 2.3 : 1.9));
        _m.compose(_p, _flat, _s);
        r.setMatrixAt(ringCount, _m);
        _c.copy(WINDOW_COLOR).multiplyScalar(lit ? 3.2 : 2.2);
        r.setColorAt(ringCount, _c);
        ringCount++;
      }
    });
    b.count = layout.list.length;
    h.count = layout.list.length;
    r.count = ringCount;
    [b, h, r].forEach((mesh) => {
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    b.computeBoundingSphere();
    h.computeBoundingSphere();
    anim.current.forEach((_, key) => {
      if (!seen.has(key)) anim.current.delete(key);
    });

    // Liens parent -> enfant (arcs) + impulsions vers les enfants actifs.
    const positions = arcs.getAttribute("position") as THREE.BufferAttribute;
    const colors = arcs.getAttribute("color") as THREE.BufferAttribute;
    let pulseCount = 0;
    lineage.edges.forEach(([from, to], e) => {
      const pa = anim.current.get(from);
      const pb = anim.current.get(to);
      const child = layout.byKey.get(to);
      if (!pa || !pb || !child) return;
      _a.copy(pa.pos);
      _b.copy(pb.pos);
      _ctrl.copy(_a).add(_b).multiplyScalar(0.5);
      _ctrl.y += 0.3;
      const touched = [from, to].some((key) => key === hovered.current || key === `p:${focus}`);
      const color = child.n.inApp ? palette.accent : palette.muted;
      const glow = touched ? 1.4 : child.n.inApp ? 0.5 : 0.25;
      for (let s = 0; s < ARC_SEGMENTS; s++) {
        const o = (e * ARC_SEGMENTS + s) * 2;
        bezier(_p, _a, _ctrl, _b, s / ARC_SEGMENTS);
        positions.setXYZ(o, _p.x, _p.y, _p.z);
        bezier(_p, _a, _ctrl, _b, (s + 1) / ARC_SEGMENTS);
        positions.setXYZ(o + 1, _p.x, _p.y, _p.z);
        colors.setXYZ(o, color.r * glow * 0.5, color.g * glow * 0.5, color.b * glow * 0.5);
        colors.setXYZ(o + 1, color.r * glow, color.g * glow, color.b * glow);
      }
      if (animate && child.load > 0.2 && pulseCount < MAX_NODES) {
        const f = (t * (0.35 + Math.min(1, child.load / 20)) + e * 0.37) % 1;
        bezier(_p, _a, _ctrl, _b, f);
        _s.setScalar(0.028);
        _m.compose(_p, _q, _s);
        pu.setMatrixAt(pulseCount, _m);
        _c.copy(color).multiplyScalar(3);
        pu.setColorAt(pulseCount, _c);
        pulseCount++;
      }
    });
    positions.needsUpdate = true;
    colors.needsUpdate = true;
    arcs.computeBoundingSphere();
    pu.count = pulseCount;
    pu.instanceMatrix.needsUpdate = true;
    if (pu.instanceColor) pu.instanceColor.needsUpdate = true;
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const item = e.instanceId === undefined ? undefined : layout.list[e.instanceId];
    if (!item) return;
    hovered.current = item.n.key;
    document.body.style.cursor = item.n.node ? "pointer" : "default";
    onHover?.({ key: item.n.key, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.(null);
  };

  // Étiquettes : nœuds des couloirs peu peuplés, le focus et les surplus « +N ».
  const labelled = layout.list.filter(({ n }) => {
    if (!n.node) return true;
    if (n.node.proc.pid === focus) return true;
    return lineage.slots[n.lane] <= (n.lane <= 2 ? 5 : 4);
  });

  return (
    <>
      <primitive object={root} />
      <lineSegments geometry={arcs} material={lineMat} raycast={() => null} frustumCulled={false} />
      <instancedMesh ref={bodies} args={[sphere, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={rings} args={[torus, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={pulses} args={[sphere, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
      <instancedMesh
        ref={hits}
        args={[sphere, hitMat, MAX_NODES]}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const item = e.instanceId === undefined ? undefined : layout.list[e.instanceId];
          if (item?.n.node) onSelect?.(item.n.node.proc.pid);
        }}
      />
      {labelled.map(({ n, target, size }) => (
        <Html key={n.key} position={[target.x, target.y + size + 0.16, target.z]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          {n.node ? (
            <span
              className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-medium shadow ${
                n.node.proc.pid === focus ? "bg-accent text-accent-fg" : "border border-line bg-surface-2/90 text-foreground"
              }`}
            >
              {n.node.proc.name ?? `PID ${n.node.proc.pid}`}
            </span>
          ) : (
            <span className="whitespace-nowrap rounded-full border border-line bg-surface-2/90 px-2 py-0.5 font-mono text-[10px] text-muted">+{n.overflow}</span>
          )}
        </Html>
      ))}
      {LANE_TITLES.map((title, lane) => (
        <Html key={title} position={[LANES_X[lane], TOP_Y, 1.45]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <span className={`whitespace-nowrap text-[9px] uppercase tracking-[0.18em] ${lane === 2 ? "text-accent" : "text-muted"}`}>
            {title}
            {lineage.totals[lane] > 0 && <span className="ml-1 font-mono tracking-normal">· {lineage.totals[lane]}</span>}
          </span>
        </Html>
      ))}
    </>
  );
}

export default function LineageGraph(props: LineageGraphProps) {
  const app = props.lineage.nodes.find((n) => n.lane === 2 && n.node)?.node?.proc.name ?? "application";
  return (
    <Stage
      poster="/models/lineage_poster.png"
      label={`Lignée 3D de ${app} : ${props.lineage.totals[1]} parent(s), ${props.lineage.totals[3]} enfant(s), ${props.lineage.totals[4]} descendant(s)`}
      camera={<LineageCamera />}
      fps={30}
    >
      <LineageModel {...props} />
    </Stage>
  );
}
