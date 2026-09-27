"use client";

/**
 * Constellation réseau 3D : le poste au centre, un nœud par IP distante (anneau LAN ou
 * Internet), un arc du cœur vers chaque nœud. Des impulsions parcourent les arcs des
 * connexions établies ; un nœud ambre = tentatives sans réponse (SYN_SENT). Autour du moyeu,
 * un mât par port en écoute : haut et ambre s'il est exposé au réseau.
 *
 * Modèle généré par Blender (assets/3d/build_netmap.py -> public/models/netmap.glb).
 * Contrat : Net_Core (MAT_HubCore) ; RING_* / GROUND_TOP / CORE_Z repris de build_netmap.py.
 * Position d'une IP = hachage de l'adresse : stable d'un rafraîchissement à l'autre.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { hash32, MAX_NODES, MAX_PORTS, type NetNode, type PortNode } from "@/lib/netmap";
import { Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/netmap.glb";
useGLTF.preload(MODEL_URL);

const RING_PORTS = 0.72;
const RING_LAN = 1.5;
const RING_WAN = 2.75;
const GROUND_TOP = 0.11;
const CORE_Z = 0.62;
const NODE_Y = GROUND_TOP + 0.3;
const ARC_SEGMENTS = 14;
const LAN_COLOR = new THREE.Color("#22d3ee"); // = CYAN de dtx3d (anneau LAN du modèle)

export type NetHover =
  | { kind: "node"; ip: string; x: number; y: number }
  | { kind: "port"; key: string; x: number; y: number };

export interface NetworkMapProps {
  nodes: NetNode[];
  ports: PortNode[];
  selected: string | null; // IP
  highlight: string | null; // IP survolée dans la liste
  throughput: number; // octets/s montants + descendants
  onHover?: (hover: NetHover | null) => void;
  onSelect?: (ip: string | null) => void;
}

interface Placed {
  node: NetNode;
  pos: THREE.Vector3;
  ctrl: THREE.Vector3; // point de contrôle de l'arc (bézier quadratique)
  size: number;
  phase: number;
  outbound: boolean;
}

const CORE = new THREE.Vector3(0, CORE_Z, 0);

function place(node: NetNode): Placed {
  const h = hash32(node.ip);
  const angle = (h / 2 ** 32) * Math.PI * 2;
  const ring = node.scope === "public" ? RING_WAN : node.scope === "private" ? RING_LAN : (RING_LAN + RING_WAN) / 2;
  const r = ring + (((h >>> 8) & 0xff) / 255 - 0.5) * 0.36; // léger décalage : moins de chevauchements
  const pos = new THREE.Vector3(Math.cos(angle) * r, NODE_Y, Math.sin(angle) * r);
  const ctrl = pos.clone().add(CORE).multiplyScalar(0.5);
  ctrl.y += 0.45 + r * 0.12;
  return {
    node,
    pos,
    ctrl,
    size: Math.min(0.16, 0.05 + 0.035 * Math.sqrt(node.connections.length)),
    phase: ((h >>> 16) & 0xff) / 255,
    outbound: (h & 1) === 1,
  };
}

/** Point d'une courbe de Bézier quadratique (sans allocation). */
function bezier(out: THREE.Vector3, a: THREE.Vector3, c: THREE.Vector3, b: THREE.Vector3, t: number) {
  const u = 1 - t;
  out.set(
    u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    u * u * a.y + 2 * u * t * c.y + t * t * b.y,
    u * u * a.z + 2 * u * t * c.z + t * t * b.z,
  );
  return out;
}

function nodeColor(palette: Palette, node: NetNode): THREE.Color {
  if (node.attempts > 0) return palette.warn;
  if (node.established === 0) return palette.muted;
  return node.scope === "public" ? palette.accent : LAN_COLOR;
}

function NetCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 32;
  const half = THREE.MathUtils.degToRad(fov / 2);
  const dist = Math.max(3.6 / (Math.tan(half) * aspect), 2.35 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.74, 0.67).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={80}
      position={[dir.x * dist, 0.3 + dir.y * dist, dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.3, 0)}
    />
  );
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function NetModel({ nodes, ports, selected, highlight, throughput, onHover, onSelect }: NetworkMapProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    let core: THREE.MeshStandardMaterial | null = null;
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && (obj.material as THREE.Material).name === "MAT_HubCore") {
        core ??= (obj.material as THREE.MeshStandardMaterial).clone();
        obj.material = core;
      }
    });
    return { root, core: core as THREE.MeshStandardMaterial | null };
  }, [scene]);

  const placed = useMemo(() => nodes.map(place), [nodes]);
  const spin = useRef<THREE.Group>(null);
  const bodies = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const pulses = useRef<THREE.InstancedMesh>(null);
  const masts = useRef<THREE.InstancedMesh>(null);
  const hovered = useRef<string | null>(null);
  const liveCore = useRef<THREE.MeshStandardMaterial | null>(null);

  const sphere = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const mast = useMemo(() => new THREE.BoxGeometry(0.05, 1, 0.05).translate(0, 0.5, 0), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const lineMat = useMemo(() => new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, toneMapped: false }), []);

  // Arcs : un segment de ligne par pas de la courbe, recalculés quand les nœuds changent.
  const arcs = useMemo(() => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array(Math.max(1, placed.length) * ARC_SEGMENTS * 6);
    const tmp = new THREE.Vector3();
    placed.forEach((pl, i) => {
      for (let s = 0; s < ARC_SEGMENTS; s++) {
        const o = (i * ARC_SEGMENTS + s) * 6;
        bezier(tmp, CORE, pl.ctrl, pl.pos, s / ARC_SEGMENTS).toArray(positions, o);
        bezier(tmp, CORE, pl.ctrl, pl.pos, (s + 1) / ARC_SEGMENTS).toArray(positions, o + 3);
      }
    });
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(new Float32Array(positions.length), 3));
    geo.setDrawRange(0, placed.length * ARC_SEGMENTS * 2);
    return geo;
  }, [placed]);

  const portPlaced = useMemo(
    () =>
      ports.map((port) => {
        const angle = (hash32(port.key) / 2 ** 32) * Math.PI * 2;
        return { port, x: Math.cos(angle) * RING_PORTS, z: Math.sin(angle) * RING_PORTS };
      }),
    [ports],
  );

  useEffect(() => {
    liveCore.current = rig.core;
    return () => {
      liveCore.current = null;
      rig.core?.dispose();
    };
  }, [rig]);
  useEffect(() => () => arcs.dispose(), [arcs]);
  useEffect(
    () => () => {
      sphere.dispose();
      mast.dispose();
      glowMat.dispose();
      hitMat.dispose();
      lineMat.dispose();
    },
    [sphere, mast, glowMat, hitMat, lineMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    if (spin.current && animate && hovered.current === null) spin.current.rotation.y += delta * 0.04;

    // Cœur : pulsation dont la cadence suit le débit réseau (échelle log).
    const core = liveCore.current;
    if (core) {
      const speed = 1 + Math.min(6, Math.log10(1 + throughput / 1024) * 1.4);
      core.emissive.copy(palette.accent);
      core.emissiveIntensity = 2.2 + (animate ? 1.2 * (0.5 + 0.5 * Math.sin(t * speed)) : 0.6);
    }

    const b = bodies.current;
    const hb = hits.current;
    const pu = pulses.current;
    const colors = arcs.getAttribute("color") as THREE.BufferAttribute;
    if (b && hb && pu) {
      placed.forEach((pl, i) => {
        const ip = pl.node.ip;
        const focus = ip === selected || ip === highlight || ip === hovered.current;
        const dim = (selected !== null || highlight !== null) && !focus;
        const color = nodeColor(palette, pl.node);
        const bob = animate ? Math.sin(t * 1.2 + pl.phase * 6.28) * 0.03 : 0;

        _p.copy(pl.pos);
        _p.y += bob;
        _s.setScalar(pl.size * (focus ? 1.5 : 1));
        _m.compose(_p, _q, _s);
        b.setMatrixAt(i, _m);
        _s.setScalar(Math.max(0.14, pl.size * 2.2)); // zone de survol plus large que la sphère
        _m.compose(_p, _q, _s);
        hb.setMatrixAt(i, _m);
        const glow = focus ? 3.6 : pl.node.established > 0 || pl.node.attempts > 0 ? 1.7 : 0.45;
        _c.copy(color).multiplyScalar(dim ? glow * 0.35 : glow);
        b.setColorAt(i, _c);

        // Arc : plus lumineux vers le nœud, estompé si un autre nœud est sélectionné.
        const arcGlow = focus ? 1.6 : dim ? 0.08 : pl.node.established > 0 ? 0.45 : 0.18;
        for (let s = 0; s < ARC_SEGMENTS * 2; s++) {
          const k = arcGlow * (0.35 + (0.65 * Math.floor(s / 2)) / ARC_SEGMENTS);
          colors.setXYZ(i * ARC_SEGMENTS * 2 + s, color.r * k, color.g * k, color.b * k);
        }

        // Impulsion : seulement sur les connexions établies.
        if (pl.node.established > 0 && animate) {
          const f = (t * 0.35 + pl.phase) % 1;
          bezier(_p, CORE, pl.ctrl, pl.pos, pl.outbound ? f : 1 - f);
          _s.setScalar(focus ? 0.045 : 0.03);
        } else {
          _s.setScalar(0);
        }
        _m.compose(_p, _q, _s);
        pu.setMatrixAt(i, _m);
        _c.copy(color).multiplyScalar(dim ? 0.6 : 3.2);
        pu.setColorAt(i, _c);
      });
      [b, hb, pu].forEach((mesh) => {
        mesh.count = placed.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      });
      b.computeBoundingSphere();
      hb.computeBoundingSphere();
      colors.needsUpdate = true;
    }

    const mm = masts.current;
    if (mm) {
      portPlaced.forEach((pp, i) => {
        const h = pp.port.exposed ? 0.34 : 0.14;
        _p.set(pp.x, GROUND_TOP, pp.z);
        _s.set(1, h, 1);
        _m.compose(_p, _q, _s);
        mm.setMatrixAt(i, _m);
        _c.copy(pp.port.exposed ? palette.warn : palette.muted).multiplyScalar(pp.port.exposed ? 1.9 : 0.55);
        mm.setColorAt(i, _c);
      });
      mm.count = portPlaced.length;
      mm.instanceMatrix.needsUpdate = true;
      if (mm.instanceColor) mm.instanceColor.needsUpdate = true;
      mm.computeBoundingSphere();
    }
  });

  const onNodeMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const pl = e.instanceId === undefined ? undefined : placed[e.instanceId];
    if (!pl) return;
    hovered.current = pl.node.ip;
    document.body.style.cursor = "pointer";
    onHover?.({ kind: "node", ip: pl.node.ip, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onPortMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const pp = e.instanceId === undefined ? undefined : portPlaced[e.instanceId];
    if (!pp) return;
    hovered.current = null;
    document.body.style.cursor = "help";
    onHover?.({ kind: "port", key: pp.port.key, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.(null);
  };

  const labelled = placed.filter((pl) => pl.node.ip === selected || pl.node.ip === highlight);

  return (
    <>
      <group ref={spin}>
        <primitive
          object={rig.root}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            onSelect?.(null);
          }}
        />
        <lineSegments geometry={arcs} material={lineMat} raycast={() => null} />
        <instancedMesh ref={bodies} args={[sphere, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
        <instancedMesh ref={pulses} args={[sphere, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
        <instancedMesh
          ref={hits}
          args={[sphere, hitMat, MAX_NODES]}
          frustumCulled={false}
          onPointerMove={onNodeMove}
          onPointerOut={onOut}
          onClick={(e: ThreeEvent<MouseEvent>) => {
            e.stopPropagation();
            const pl = e.instanceId === undefined ? undefined : placed[e.instanceId];
            if (pl) onSelect?.(pl.node.ip === selected ? null : pl.node.ip);
          }}
        />
        <instancedMesh ref={masts} args={[mast, glowMat, MAX_PORTS]} frustumCulled={false} onPointerMove={onPortMove} onPointerOut={onOut} />
        {labelled.map((pl) => (
          <Html key={pl.node.ip} position={[pl.pos.x, pl.pos.y + 0.28, pl.pos.z]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <span className="whitespace-nowrap rounded border border-line bg-surface-2/90 px-1.5 py-0.5 font-mono text-[10px] text-foreground shadow">
              {pl.node.ip}
            </span>
          </Html>
        ))}
      </group>
      {/* Légende des anneaux, fixe (hors du groupe qui tourne). */}
      {[
        { r: RING_LAN, text: "LAN" },
        { r: RING_WAN, text: "Internet" },
      ].map((ring) => (
        <Html key={ring.text} position={[0, GROUND_TOP, ring.r + 0.12]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted">{ring.text}</span>
        </Html>
      ))}
    </>
  );
}

export default function NetworkMap(props: NetworkMapProps) {
  const exposed = props.ports.filter((p) => p.exposed).length;
  return (
    <Stage
      poster="/models/netmap_poster.png"
      label={`Constellation réseau 3D : ${props.nodes.length} hôtes distants, ${props.ports.length} ports en écoute dont ${exposed} exposés au réseau`}
      camera={<NetCamera />}
      fps={30}
    >
      <NetModel {...props} />
    </Stage>
  );
}
