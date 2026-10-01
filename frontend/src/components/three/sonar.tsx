"use client";

/**
 * « Sonar » 3D (page Réseau local). La box au centre, sous une coupole de verre. Un écho par
 * appareil du réseau :
 *   secteur = type (ordinateurs, téléphones, maison, objets connectés, inconnus — face à la caméra) ;
 *   anneau = confiance (approuvé près de la box, connu, NOUVEAU sur l'anneau ambre « à la porte ») ;
 *   hauteur du mât = exposition (risque et nombre de ports ouverts), plafonnée sous la coupole ;
 *   couleur = ce qui demande d'agir (usurpation, port à risque, nouveauté) ; atténué si absent.
 * Le faisceau tourne (plus vite pendant un scan) et allume ce qu'il survole ; l'onde de ping se
 * propage pendant un scan. Usurpation de la box : son double rouge apparaît et clignote.
 *
 * Modèle généré par Blender (assets/3d/build_sonar.py -> public/models/sonar.glb).
 * Contrat : Sonar_Sector_00..04 (userData.sector_index), Sonar_Beam, Sonar_Pulse, Sonar_Gateway,
 * Sonar_Dome(+Lines), Glyph_Library > Glyph_<type>, Glyph_Echo, Glyph_Stalk ; matériaux
 * MAT_SonarSector, MAT_SonarCore, MAT_RingNew, MAT_SonarPulse, MAT_GlyphBody, MAT_GlyphGlow.
 * Constantes : lib/sonar.ts (SONAR).
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { DeviceKind, NetDevice } from "@/lib/api";
import { displayName, isPresent, layoutSonar, RISK_RANK, SECTOR_LABEL, sectorAngle, SONAR, type SonarNode } from "@/lib/sonar";
import { FitCamera, ringPoints, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/sonar.glb";
useGLTF.preload(MODEL_URL);

const { GROUND_TOP, R_MIN, OUTER_R, RING_TRUSTED, RING_KNOWN, RING_NEW, DOME_H, GLYPH_SIZE, SECTORS } = SONAR;
const GLYPH_KINDS = ["computer", "mobile", "printer", "camera", "media", "nas", "iot", "unknown"] as const;
type GlyphKind = (typeof GLYPH_KINDS)[number];
const MAX_NODES = 256;
const LABEL_R = OUTER_R + 0.42;
const TWO_PI = Math.PI * 2;
const NO_RAYCAST = new Set(["Sonar_Dome", "Sonar_DomeLines", "Sonar_Beam", "Sonar_Pulse", "Glyph_Library"]);

export interface SonarHover {
  id: string;
  x: number;
  y: number;
}

export interface SonarProps {
  devices: NetDevice[];
  now: number;
  selected: string | null;
  scanning: boolean;
  onHover?: (hover: SonarHover | null) => void;
  onSelect?: (id: string | null) => void;
}

const glyphOf = (kind: DeviceKind): GlyphKind => ((GLYPH_KINDS as readonly string[]).includes(kind) ? (kind as GlyphKind) : "unknown");

/** Couleur qui dit s'il faut agir : usurpation > port à risque > nouveauté > présent > absent. */
function deviceColor(palette: Palette, d: NetDevice, present: boolean): THREE.Color {
  if (d.gateway_mismatch || d.risk === "critical") return palette.critical;
  if (RISK_RANK[d.risk] >= RISK_RANK.high || d.status === "new") return palette.warn;
  return present ? palette.accent : palette.muted;
}

const VIEW_POINTS = [...ringPoints(LABEL_R + 0.3, GROUND_TOP), ...ringPoints(OUTER_R * 0.55, GROUND_TOP + DOME_H, 12)];

function SonarCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width > 0 && size.height > 0 ? size.width / size.height : 1.6;
  const direction: [number, number, number] = aspect > 2.2 ? [0, 0.5, 0.87] : aspect > 1.4 ? [0, 0.6, 0.8] : [0, 0.72, 0.7];
  return <FitCamera points={VIEW_POINTS} direction={direction} fov={30} margin={0.03} />;
}

interface GlyphGeo {
  body: THREE.BufferGeometry | null;
  glow: THREE.BufferGeometry | null;
}

interface Rig {
  root: THREE.Object3D;
  beam: THREE.Object3D | null;
  pulse: THREE.Object3D | null;
  pulseMat: THREE.MeshStandardMaterial | null;
  ghost: THREE.Object3D | null;
  ghostMat: THREE.MeshBasicMaterial | null;
  floors: (THREE.MeshStandardMaterial | null)[];
  core: THREE.MeshStandardMaterial | null;
  ringNew: THREE.MeshStandardMaterial | null;
  bodyMat: THREE.Material | null;
  glyphs: Record<GlyphKind, GlyphGeo>;
  echo: THREE.BufferGeometry | null;
  stalk: THREE.BufferGeometry | null;
  owned: THREE.Material[];
}

function named(obj: THREE.Object3D, names: Set<string>): boolean {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) if (names.has(o.name)) return true;
  return false;
}

/** Clone du modèle : matériaux propres (secteurs, cœur, onde), bibliothèque de silhouettes extraite. */
function useRig(scene: THREE.Object3D): Rig {
  return useMemo(() => {
    const root = scene.clone(true);
    const rig: Rig = {
      root,
      beam: null,
      pulse: null,
      pulseMat: null,
      ghost: null,
      ghostMat: null,
      floors: Array(SECTORS.length).fill(null),
      core: null,
      ringNew: null,
      bodyMat: null,
      glyphs: Object.fromEntries(GLYPH_KINDS.map((k) => [k, { body: null, glow: null }])) as Record<GlyphKind, GlyphGeo>,
      echo: null,
      stalk: null,
      owned: [],
    };
    const shared = new Map<string, THREE.MeshStandardMaterial>();
    const own = (mat: THREE.MeshStandardMaterial) => {
      let m = shared.get(mat.name);
      if (!m) {
        m = mat.clone();
        shared.set(mat.name, m);
        rig.owned.push(m);
      }
      return m;
    };
    let gateway: THREE.Object3D | null = null;
    root.traverse((obj) => {
      if (obj.name === "Sonar_Beam") rig.beam = obj;
      if (obj.name === "Sonar_Pulse") rig.pulse = obj;
      if (obj.name === "Sonar_Gateway") gateway = obj;
      if (obj.name === "Glyph_Library") obj.visible = false; // le web clone, il n'affiche pas
      if (!(obj instanceof THREE.Mesh)) return;
      if (named(obj, NO_RAYCAST)) obj.raycast = () => undefined; // la coupole ne doit pas intercepter les clics
      const mat = obj.material as THREE.MeshStandardMaterial;
      // Bibliothèque : géométries des silhouettes (un sous-maillage par matériau).
      const glyph = GLYPH_KINDS.find((k) => obj.name === `Glyph_${k}` || obj.parent?.name === `Glyph_${k}`);
      if (glyph) {
        if (mat.name === "MAT_GlyphBody") {
          rig.glyphs[glyph].body = obj.geometry;
          rig.bodyMat ??= mat;
        } else if (mat.name === "MAT_GlyphGlow") rig.glyphs[glyph].glow = obj.geometry;
        return;
      }
      if (obj.name === "Glyph_Echo") rig.echo = obj.geometry;
      if (obj.name === "Glyph_Stalk") rig.stalk = obj.geometry;
      const index: unknown = obj.userData.sector_index ?? obj.parent?.userData.sector_index;
      if (typeof index === "number" && mat.name === "MAT_SonarSector") {
        const m = mat.clone();
        obj.material = m;
        rig.owned.push(m);
        rig.floors[index] = m;
      } else if (mat.name === "MAT_SonarCore" || mat.name === "MAT_RingNew" || mat.name === "MAT_SonarPulse") {
        obj.material = own(mat);
      }
    });
    rig.core = shared.get("MAT_SonarCore") ?? null;
    rig.ringNew = shared.get("MAT_RingNew") ?? null;
    rig.pulseMat = shared.get("MAT_SonarPulse") ?? null;
    // Double de la box : visible seulement quand un appareil usurpe son adresse.
    const gw = gateway as THREE.Object3D | null;
    if (gw) {
      const ghostMat = new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.5, depthWrite: false });
      rig.owned.push(ghostMat);
      const ghost = gw.clone(true);
      ghost.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.material = ghostMat;
          o.raycast = () => undefined;
        }
      });
      ghost.visible = false;
      ghost.name = "Sonar_GatewayGhost";
      gw.parent?.add(ghost);
      rig.ghost = ghost;
      rig.ghostMat = ghostMat;
    }
    return rig;
  }, [scene]);
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function SonarModel({ devices, now, selected, scanning, onHover, onSelect }: SonarProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useRig(scene);
  const live = useRef<Rig | null>(null);
  const hovered = useRef<string | null>(null);
  const beamAngle = useRef(Math.PI * 1.25);

  const bodies = useRef<Partial<Record<GlyphKind, THREE.InstancedMesh | null>>>({});
  const glows = useRef<Partial<Record<GlyphKind, THREE.InstancedMesh | null>>>({});
  const echoes = useRef<THREE.InstancedMesh>(null);
  const stalks = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.Mesh>(null);

  const nodes = useMemo(() => layoutSonar(devices.slice(0, MAX_NODES)), [devices]);
  const byKind = useMemo(() => {
    const out = Object.fromEntries(GLYPH_KINDS.map((k) => [k, [] as SonarNode[]])) as Record<GlyphKind, SonarNode[]>;
    for (const n of nodes) out[glyphOf(n.d.kind)].push(n);
    return out;
  }, [nodes]);
  const spoofed = useMemo(() => devices.some((d) => d.gateway_mismatch), [devices]);
  const anyNew = useMemo(() => devices.some((d) => d.status === "new"), [devices]);
  const sectorAlert = useMemo(() => {
    const worst: (THREE.Color | null)[] = Array(SECTORS.length).fill(null);
    for (const n of nodes) {
      const c = deviceColor(palette, n.d, true);
      if (c !== palette.accent && (worst[n.sector] === null || c === palette.critical)) worst[n.sector] = c;
    }
    return worst;
  }, [nodes, palette]);

  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const echoMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9 }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const hitGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false, transparent: true, opacity: 0.9 }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.owned.forEach((m) => m.dispose());
    };
  }, [rig]);
  useEffect(
    () => () => {
      hitGeo.dispose();
      [glowMat, echoMat, hitMat, haloMat].forEach((m) => m.dispose());
    },
    [hitGeo, glowMat, echoMat, hitMat, haloMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const r = live.current;
    if (animate) beamAngle.current = (beamAngle.current + delta * (scanning ? 1.6 : 0.35)) % TWO_PI;
    const head = beamAngle.current;

    if (r) {
      if (r.beam) r.beam.rotation.y = -head; // lame modélisée à φ = 0 (+X)
      if (r.pulse && r.pulseMat) {
        // Onde de ping : en continu pendant un scan, discrète toutes les 8 s sinon.
        const period = scanning ? 2.2 : 8;
        const u = (t % period) / period;
        const active = animate && (scanning || u < 0.3);
        const grow = scanning ? u : u / 0.3;
        r.pulse.visible = active;
        r.pulse.scale.setScalar(R_MIN + (OUTER_R - R_MIN) * grow);
        r.pulse.scale.y = 1;
        r.pulseMat.opacity = active ? (scanning ? 0.7 : 0.35) * (1 - grow) : 0;
      }
      const coreColor = spoofed ? palette.critical : anyNew ? palette.warn : palette.accent;
      if (r.core) {
        r.core.emissive.copy(coreColor);
        r.core.emissiveIntensity = spoofed && animate ? 2 + 2 * (0.5 + 0.5 * Math.sin(t * 6)) : 2.8;
      }
      if (r.ringNew) r.ringNew.emissiveIntensity = anyNew && animate ? 1.2 + 0.8 * (0.5 + 0.5 * Math.sin(t * 2.4)) : anyNew ? 1.8 : 0.9;
      if (r.ghost && r.ghostMat) {
        r.ghost.visible = spoofed;
        if (spoofed) {
          // Le double de la box tremble et clignote : deux appareils répondent pour la même adresse.
          r.ghost.position.set(0.32 + (animate ? Math.sin(t * 13) * 0.02 : 0), 0.02, 0.22);
          r.ghostMat.color.copy(palette.critical).multiplyScalar(2);
          r.ghostMat.opacity = animate ? 0.25 + 0.35 * (0.5 + 0.5 * Math.sin(t * 9)) : 0.45;
        }
      }
      const sel = nodes.find((n) => n.d.id === selected)?.sector ?? -1;
      for (let i = 0; i < SECTORS.length; i++) {
        const floor = r.floors[i];
        if (!floor) continue;
        const c = sectorAlert[i];
        floor.emissive.copy(c ?? palette.accent);
        floor.emissiveIntensity = (c ? 0.12 : 0) + (i === sel ? 0.16 : 0);
      }
    }

    // Échos : une instance par appareil et par type de silhouette.
    for (const kind of GLYPH_KINDS) {
      const list = byKind[kind];
      const body = bodies.current[kind];
      const glow = glows.current[kind];
      list.forEach((n, i) => {
        const present = isPresent(n.d, now);
        const focus = n.d.id === selected || n.d.id === hovered.current;
        const lag = (((head - n.angle) % TWO_PI) + TWO_PI) % TWO_PI;
        const ping = animate && lag < 0.5 ? 1 - lag / 0.5 : 0;
        const bob = animate && n.d.status === "new" ? 0.03 * Math.sin(t * 2.2 + i) : 0;
        _q.identity();
        _p.set(n.x, GROUND_TOP + 0.02 + n.lift + bob, n.z);
        _s.setScalar(focus ? 1.18 : 1);
        _m.compose(_p, _q, _s);
        body?.setMatrixAt(i, _m);
        glow?.setMatrixAt(i, _m);
        _c.copy(deviceColor(palette, n.d, present)).multiplyScalar((present ? 1.6 : 0.5) + 1.6 * ping + (focus ? 1.2 : 0));
        glow?.setColorAt(i, _c);
      });
      for (const mesh of [body, glow]) {
        if (!mesh) continue;
        mesh.count = list.length;
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }

    const ec = echoes.current;
    const st = stalks.current;
    const hi = hits.current;
    if (!ec || !st || !hi) return;
    nodes.forEach((n, i) => {
      const present = isPresent(n.d, now);
      const color = deviceColor(palette, n.d, present);
      const lag = (((head - n.angle) % TWO_PI) + TWO_PI) % TWO_PI;
      const ping = animate && lag < 0.5 ? 1 - lag / 0.5 : 0;
      _q.identity();
      _p.set(n.x, GROUND_TOP + 0.016, n.z);
      _s.setScalar(n.d.id === selected ? 1.25 : 1);
      _m.compose(_p, _q, _s);
      ec.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar((present ? 1.2 : 0.35) + ping);
      ec.setColorAt(i, _c);

      _s.set(1, Math.max(0.0001, n.lift + 0.02), 1);
      _m.compose(_p, _q, _s);
      st.setMatrixAt(i, _m);
      _c.copy(color).multiplyScalar(n.lift > 0 ? (present ? 1.1 : 0.3) : 0);
      st.setColorAt(i, _c);

      _p.set(n.x, GROUND_TOP, n.z);
      _s.set(GLYPH_SIZE * 1.2, n.lift + GLYPH_SIZE + 0.05, GLYPH_SIZE * 1.2);
      _m.compose(_p, _q, _s);
      hi.setMatrixAt(i, _m);
    });
    for (const mesh of [ec, st, hi]) {
      mesh.count = nodes.length;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    hi.computeBoundingSphere();

    const h = halo.current;
    const sn = selected ? nodes.find((n) => n.d.id === selected) : undefined;
    if (h) {
      h.visible = sn !== undefined;
      if (sn) {
        const k = animate ? 1 + 0.2 * Math.sin(t * 4) : 1.1;
        h.position.set(sn.x, GROUND_TOP + 0.02, sn.z);
        h.scale.setScalar(0.42 * k);
        haloMat.color.copy(deviceColor(palette, sn.d, true)).multiplyScalar(2.6);
      }
    }
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>): SonarNode | undefined => (e.instanceId === undefined ? undefined : nodes[e.instanceId]);
  const selectedNode = selected ? nodes.find((n) => n.d.id === selected) : undefined;
  const gatewayDevice = devices.find((d) => d.is_gateway);
  const ringAngle = sectorAngle(4) - (Math.PI * 2) / SECTORS.length / 2; // frontière gauche du secteur « Inconnus »

  return (
    <>
      <primitive
        object={rig.root}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.(gatewayDevice && e.object.name.startsWith("Sonar_Gateway") ? gatewayDevice.id : null);
        }}
      />
      {GLYPH_KINDS.map((kind) => {
        const g = rig.glyphs[kind];
        return (
          <group key={kind}>
            {g.body && rig.bodyMat && (
              <instancedMesh ref={(m) => void (bodies.current[kind] = m)} args={[g.body, rig.bodyMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />
            )}
            {g.glow && <instancedMesh ref={(m) => void (glows.current[kind] = m)} args={[g.glow, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />}
          </group>
        );
      })}
      {rig.echo && <instancedMesh ref={echoes} args={[rig.echo, echoMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />}
      {rig.stalk && <instancedMesh ref={stalks} args={[rig.stalk, glowMat, MAX_NODES]} frustumCulled={false} raycast={() => null} />}
      <mesh ref={halo} material={haloMat} visible={false} raycast={() => null} rotation-x={Math.PI / 2}>
        <torusGeometry args={[1, 0.035, 4, 48]} />
      </mesh>
      <instancedMesh
        ref={hits}
        args={[hitGeo, hitMat, MAX_NODES]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const n = pick(e);
          if (!n) return;
          hovered.current = n.d.id;
          document.body.style.cursor = "pointer";
          onHover?.({ id: n.d.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const n = pick(e);
          if (n) onSelect?.(n.d.id === selected ? null : n.d.id);
        }}
      />

      {SECTORS.map((sector, i) => {
        const a = sectorAngle(i);
        const alert = sectorAlert[i];
        return (
          <Html key={sector} position={[Math.cos(a) * LABEL_R, GROUND_TOP, Math.sin(a) * LABEL_R]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
            <span className={`whitespace-nowrap text-[10px] font-medium ${alert === palette.critical ? "text-critical" : alert ? "text-warn" : "text-muted"}`}>{SECTOR_LABEL[sector]}</span>
          </Html>
        );
      })}
      {(
        [
          [RING_TRUSTED, "approuvés"],
          [RING_KNOWN, "connus"],
          [RING_NEW, "nouveaux"],
        ] as const
      ).map(([radius, label]) => (
        <Html key={label} position={[Math.cos(ringAngle) * radius, GROUND_TOP + 0.02, Math.sin(ringAngle) * radius]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
          <span className={`rounded bg-surface/70 px-1 font-mono text-[9px] ${label === "nouveaux" ? "text-warn" : "text-muted"}`}>{label}</span>
        </Html>
      ))}
      {gatewayDevice && (
        <Html position={[0, GROUND_TOP + 0.75, 0]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
          <span className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] ${spoofed ? "bg-critical text-white" : "bg-surface/80 text-muted"}`}>
            {spoofed ? "box usurpée ?" : `box · ${gatewayDevice.ip}`}
          </span>
        </Html>
      )}
      {selectedNode && (
        <Html position={[selectedNode.x, GROUND_TOP + selectedNode.lift + GLYPH_SIZE + 0.18, selectedNode.z]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
          <span className="max-w-[12rem] truncate whitespace-nowrap rounded bg-accent px-1.5 py-0.5 text-[10px] font-medium text-accent-fg shadow">{displayName(selectedNode.d)}</span>
        </Html>
      )}
    </>
  );
}

export default function Sonar(props: SonarProps) {
  const fresh = props.devices.filter((d) => d.status === "new").length;
  return (
    <Stage
      poster="/models/sonar_poster.png"
      label={`Sonar du réseau local : ${props.devices.length} appareil(s), dont ${fresh} nouveau(x), placés par type et par niveau de confiance`}
      camera={<SonarCamera />}
      fps={30}
    >
      <SonarModel {...props} />
    </Stage>
  );
}
