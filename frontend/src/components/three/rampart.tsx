"use client";

/**
 * « Rempart » 3D : le poste (donjon) et son pare-feu (enceinte de verre).
 *   porte scellée (bouclier) = port lié au réseau mais BLOQUÉ par le pare-feu ;
 *   porte ouverte + faisceau vers l'extérieur = port JOIGNABLE, couleur = niveau de risque,
 *     les impulsions remontent le faisceau : ce qui peut entrer ;
 *   porte grise = exposition indéterminée ; tourelle dans la cour = service local (127.0.0.1).
 * Les ports les plus risqués sont placés face à la caméra.
 *
 * Modèle généré par Blender (assets/3d/build_rampart.py -> public/models/rampart.glb).
 * Contrat : MAT_ShieldRim ; WALL_R / WALL_H / LOCAL_R / GROUND_TOP / OUTER_R repris du script.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { PortExposure, RiskLevel } from "@/lib/api";
import { portKey } from "@/lib/netmap";
import { FitCamera, ringPoints, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/rampart.glb";
useGLTF.preload(MODEL_URL);

const GROUND_TOP = 0.11;
const WALL_R = 2.2;
const WALL_H = 0.5;
const LOCAL_R = 1.25;
const OUTER_R = 3.25;
const FRONT = Math.PI / 2; // +Z : face à la caméra
const MAX_ITEMS = 160;

export interface RampartHover {
  key: string;
  x: number;
  y: number;
}

export interface RampartProps {
  ports: PortExposure[];
  firewallOn: boolean; // pare-feu actif sur le profil réseau courant
  selected: string | null;
  onHover?: (hover: RampartHover | null) => void;
  onSelect?: (key: string | null) => void;
}

const RISK_ORDER: RiskLevel[] = ["critical", "high", "medium", "low", "info"];
const OPENNESS = { open: 0, unknown: 1, blocked: 2, local: 3 } as const;

function riskColor(palette: Palette, level: RiskLevel): THREE.Color {
  if (level === "critical") return palette.critical;
  if (level === "high" || level === "medium") return palette.warn;
  if (level === "low") return palette.accent;
  return palette.muted;
}

/** Emplacements alternés autour de l'avant : 0, +1, -1, +2, -2… (les premiers face caméra). */
function frontAngle(index: number, step: number): number {
  const k = Math.ceil(index / 2);
  return FRONT + (index % 2 === 1 ? k : -k) * step;
}

interface Item {
  port: PortExposure;
  key: string;
  angle: number;
  local: boolean;
}

// Enveloppe : plateau (r 3.5), sommet de l'enceinte, étiquettes au-dessus des portes avant.
const VIEW_POINTS = [...ringPoints(3.55, 0), ...ringPoints(WALL_R, GROUND_TOP + WALL_H), ...ringPoints(WALL_R + 0.55, GROUND_TOP + WALL_H + 0.5, 16)];

function RampartCamera() {
  return <FitCamera points={VIEW_POINTS} direction={[0, 0.78, 0.63]} fov={32} />;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);
const _z = new THREE.Vector3(0, 0, 1);
const _dir = new THREE.Vector3();
const _outward = new THREE.Quaternion();

function RampartModel({ ports, firewallOn, selected, onHover, onSelect }: RampartProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    let rim: THREE.MeshStandardMaterial | null = null;
    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh && (obj.material as THREE.Material).name === "MAT_ShieldRim") {
        rim ??= (obj.material as THREE.MeshStandardMaterial).clone();
        obj.material = rim;
      }
    });
    return { root, rim: rim as THREE.MeshStandardMaterial | null };
  }, [scene]);
  const liveRim = useRef<THREE.MeshStandardMaterial | null>(null);

  const plates = useRef<THREE.InstancedMesh>(null);
  const posts = useRef<THREE.InstancedMesh>(null);
  const beams = useRef<THREE.InstancedMesh>(null);
  const pulses = useRef<THREE.InstancedMesh>(null);
  const turrets = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const hovered = useRef<string | null>(null);

  const box = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const beam = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5), []);
  const sphere = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const cylinder = useMemo(() => new THREE.CylinderGeometry(0.06, 0.075, 1, 12).translate(0, 0.5, 0), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const solidMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.3 }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);

  const items = useMemo<Item[]>(() => {
    const byRisk = (a: PortExposure, b: PortExposure) =>
      OPENNESS[a.verdict] - OPENNESS[b.verdict] || RISK_ORDER.indexOf(a.risk.level) - RISK_ORDER.indexOf(b.risk.level) || a.port - b.port;
    const wall = ports.filter((p) => p.verdict !== "local").sort(byRisk);
    const local = ports.filter((p) => p.verdict === "local").sort((a, b) => a.port - b.port);
    const wallStep = (2 * Math.PI) / Math.max(wall.length, 28);
    const localStep = (2 * Math.PI) / Math.max(local.length, 16);
    return [
      ...wall.map((port, i) => ({ port, key: portKey(port), angle: frontAngle(i, wallStep), local: false })),
      ...local.map((port, i) => ({ port, key: portKey(port), angle: frontAngle(i, localStep), local: true })),
    ].slice(0, MAX_ITEMS);
  }, [ports]);

  useEffect(() => {
    liveRim.current = rig.rim;
    return () => {
      liveRim.current = null;
      rig.rim?.dispose();
    };
  }, [rig]);
  useEffect(
    () => () => {
      [box, beam, sphere, cylinder].forEach((g) => g.dispose());
      [glowMat, solidMat, hitMat].forEach((m) => m.dispose());
    },
    [box, beam, sphere, cylinder, glowMat, solidMat, hitMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const rim = liveRim.current;
    if (rim) {
      // Liseré du pare-feu : accent s'il protège, rouge clignotant s'il est désactivé.
      rim.emissive.copy(firewallOn ? palette.accent : palette.critical);
      rim.emissiveIntensity = firewallOn ? 2.2 : 1.6 + (animate ? 1.4 * (0.5 + 0.5 * Math.sin(t * 5)) : 0.7);
    }
    const pl = plates.current;
    const po = posts.current;
    const be = beams.current;
    const pu = pulses.current;
    const tu = turrets.current;
    const hi = hits.current;
    if (!pl || !po || !be || !pu || !tu || !hi) return;

    let nPlate = 0;
    let nPost = 0;
    let nBeam = 0;
    let nTurret = 0;
    items.forEach((item, i) => {
      const { port, angle } = item;
      const focus = item.key === selected || item.key === hovered.current;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Orientation : largeur tangente au mur, profondeur radiale vers l'extérieur.
      _q.setFromAxisAngle(_up, -angle - Math.PI / 2);

      if (item.local) {
        _p.set(cos * LOCAL_R, GROUND_TOP, sin * LOCAL_R);
        _s.set(focus ? 1.3 : 1, 0.18, focus ? 1.3 : 1);
        _m.compose(_p, _q, _s);
        tu.setMatrixAt(nTurret, _m);
        _c.copy(palette.muted).multiplyScalar(focus ? 2.2 : 0.7);
        tu.setColorAt(nTurret++, _c);
        _s.set(0.22, 0.3, 0.22);
        _m.compose(_p, _q, _s);
        hi.setMatrixAt(i, _m);
        return;
      }

      _p.set(cos * WALL_R, GROUND_TOP, sin * WALL_R);
      _s.set(0.26, WALL_H + 0.1, 0.3);
      _m.compose(_p, _q, _s);
      hi.setMatrixAt(i, _m);

      if (port.verdict === "open") {
        const color = riskColor(palette, port.risk.level);
        const glow = focus ? 4 : 2.3;
        // Encadrement de porte : deux montants + linteau.
        for (const side of [-1, 1]) {
          _p.set(cos * WALL_R - sin * 0.1 * side, GROUND_TOP, sin * WALL_R + cos * 0.1 * side);
          _s.set(0.03, WALL_H - 0.04, 0.05);
          _m.compose(_p, _q, _s);
          po.setMatrixAt(nPost, _m);
          _c.copy(color).multiplyScalar(glow);
          po.setColorAt(nPost++, _c);
        }
        _p.set(cos * WALL_R, GROUND_TOP + WALL_H - 0.04, sin * WALL_R);
        _s.set(0.23, 0.03, 0.05);
        _m.compose(_p, _q, _s);
        po.setMatrixAt(nPost, _m);
        po.setColorAt(nPost++, _c);

        // Faisceau vers l'extérieur + impulsion qui remonte vers la porte (ce qui peut entrer).
        const length = OUTER_R - WALL_R - 0.1;
        _p.set(cos * (WALL_R + 0.08), GROUND_TOP + 0.02, sin * (WALL_R + 0.08));
        _outward.setFromUnitVectors(_z, _dir.set(cos, 0, sin));
        _s.set(focus ? 0.06 : 0.035, 0.02, length);
        _m.compose(_p, _outward, _s);
        be.setMatrixAt(nBeam, _m);
        _c.copy(color).multiplyScalar(focus ? 2.4 : 1.3);
        be.setColorAt(nBeam, _c);
        const f = animate ? 1 - ((t * 0.45 + i * 0.137) % 1) : 0.5;
        const r = WALL_R + 0.1 + f * length;
        _p.set(cos * r, GROUND_TOP + 0.05, sin * r);
        _s.setScalar(0.035);
        _m.compose(_p, _q, _s);
        pu.setMatrixAt(nBeam, _m);
        _c.copy(color).multiplyScalar(3.2);
        pu.setColorAt(nBeam++, _c);
      } else {
        // Porte scellée (bloquée) ou indéterminée.
        const blocked = port.verdict === "blocked";
        _p.set(cos * WALL_R, GROUND_TOP, sin * WALL_R);
        _s.set(0.2, blocked ? WALL_H - 0.08 : (WALL_H - 0.08) * 0.55, 0.06);
        _m.compose(_p, _q, _s);
        pl.setMatrixAt(nPlate, _m);
        _c.copy(blocked ? palette.accent : palette.muted).multiplyScalar(focus ? 0.9 : blocked ? 0.32 : 0.45);
        pl.setColorAt(nPlate++, _c);
      }
    });

    const counts: [THREE.InstancedMesh, number][] = [
      [pl, nPlate],
      [po, nPost],
      [be, nBeam],
      [pu, nBeam],
      [tu, nTurret],
      [hi, items.length],
    ];
    counts.forEach(([mesh, n]) => {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    });
    hi.computeBoundingSphere();
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const item = e.instanceId === undefined ? undefined : items[e.instanceId];
    if (!item) return;
    hovered.current = item.key;
    document.body.style.cursor = "pointer";
    onHover?.({ key: item.key, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onHover?.(null);
  };

  // Étiquettes : ports ouverts à risque critique et la sélection ; le reste au survol et dans la liste.
  const labelled = items.filter((it) => it.key === selected || (!it.local && it.port.verdict === "open" && it.port.risk.level === "critical"));

  return (
    <>
      <primitive
        object={rig.root}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.(null);
        }}
      />
      <instancedMesh ref={plates} args={[box, solidMat, MAX_ITEMS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={posts} args={[box, glowMat, MAX_ITEMS * 3]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={beams} args={[beam, glowMat, MAX_ITEMS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={pulses} args={[sphere, glowMat, MAX_ITEMS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={turrets} args={[cylinder, solidMat, MAX_ITEMS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh
        ref={hits}
        args={[box, hitMat, MAX_ITEMS]}
        frustumCulled={false}
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const item = e.instanceId === undefined ? undefined : items[e.instanceId];
          if (item) onSelect?.(item.key === selected ? null : item.key);
        }}
      />
      {labelled.map((it, i) => {
        const r = it.local ? LOCAL_R : WALL_R + 0.55;
        // Hauteurs alternées : deux portes voisines n'ont jamais leurs étiquettes superposées.
        const lift = it.local ? 0.4 : WALL_H + (i % 2 === 0 ? 0.1 : 0.42);
        return (
          <Html
            key={it.key}
            position={[Math.cos(it.angle) * r, GROUND_TOP + lift, Math.sin(it.angle) * r]}
            center
            zIndexRange={[5, 0]}
            style={{ pointerEvents: "none" }}
          >
            <span
              className={`whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-[10px] shadow ${
                it.key === selected ? "bg-accent text-accent-fg" : "border border-line bg-surface-2/90 text-foreground"
              }`}
            >
              {it.port.port} · {it.port.risk.service}
            </span>
          </Html>
        );
      })}
      <Html position={[0, GROUND_TOP, OUTER_R - 0.05]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
        <span className="text-[9px] uppercase tracking-[0.2em] text-muted">réseau</span>
      </Html>
      <Html position={[0, GROUND_TOP, LOCAL_R + 0.28]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
        <span className="text-[9px] uppercase tracking-[0.2em] text-muted">local</span>
      </Html>
    </>
  );
}

export default function Rampart(props: RampartProps) {
  const open = props.ports.filter((p) => p.verdict === "open").length;
  const blocked = props.ports.filter((p) => p.verdict === "blocked").length;
  return (
    <Stage
      poster="/models/rampart_poster.png"
      label={`Rempart 3D : ${open} port(s) joignable(s) depuis le réseau, ${blocked} bloqué(s) par le pare-feu`}
      camera={<RampartCamera />}
      fps={30}
    >
      <RampartModel {...props} />
    </Stage>
  );
}
