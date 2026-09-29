"use client";

/**
 * « Les Racines » 3D : ce qui se relance seul au démarrage. Sous le socle du poste, six racines
 * plongent dans un sol à trois strates (utilisateur, machine & SYSTEM, noyau), une par
 * mécanisme de persistance. Chaque entrée est un nodule le long de SA racine, à la profondeur
 * de ses privilèges : sable = Microsoft, accent = éditeur signé, ambre = non signé,
 * rouge pulsant = nouveau ou modifié depuis la référence. Une entrée désactivée est éteinte.
 *
 * Modèle généré par Blender (assets/3d/build_roots.py -> public/models/roots.glb).
 * Contrat : Root_00..05 / RootTip_00..05 (userData.root_index), MAT_Root, MAT_RootTip ;
 * géométrie des racines reprise dans lib/persistence.ts (rootPoint).
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { PersistenceEntry, PersistenceMechanism } from "@/lib/api";
import { MECHANISMS, noduleLayout, rootTip, STRATA_Y, type Nodule } from "@/lib/persistence";
import { boxPoints, FitCamera, Stage, useScene, type Palette } from "./scene-kit";

const MODEL_URL = "/models/roots.glb";
useGLTF.preload(MODEL_URL);

const MAX_NODULES = 1500;
const SAND = new THREE.Color("#c9b48a");
const VIEW_POINTS = [...boxPoints(3.35, 0.8, -3.45, 0.45), new THREE.Vector3(0, -3.75, 0)];
const STRATA_NAMES = ["Utilisateur", "Machine · SYSTEM", "Noyau"];

export interface RootsHover {
  id: string;
  x: number;
  y: number;
}

export interface RootsProps {
  entries: PersistenceEntry[];
  selected: string | null;
  focus: PersistenceMechanism | null;
  onHover?: (hover: RootsHover | null) => void;
  onSelect?: (id: string) => void;
}

function RootsCamera() {
  return <FitCamera points={VIEW_POINTS} direction={[0, 0.16, 1]} fov={30} margin={0.03} />;
}

function noduleColor(palette: Palette, n: Nodule): THREE.Color {
  switch (n.trust) {
    case "new":
      return palette.critical;
    case "risky":
      return palette.warn;
    case "signed":
      return palette.accent;
    case "microsoft":
      return SAND;
    default:
      return palette.muted;
  }
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function RootsModel({ entries, selected, focus, onHover, onSelect }: RootsProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    const roots: (THREE.MeshStandardMaterial | null)[] = Array(6).fill(null);
    const tips: (THREE.MeshStandardMaterial | null)[] = Array(6).fill(null);
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const index: unknown = obj.userData.root_index;
      const name = (obj.material as THREE.Material).name;
      if (typeof index !== "number" || (name !== "MAT_Root" && name !== "MAT_RootTip")) return;
      const own = (obj.material as THREE.MeshStandardMaterial).clone();
      obj.material = own;
      (name === "MAT_Root" ? roots : tips)[index] = own;
    });
    return { root, roots, tips };
  }, [scene]);
  const live = useRef<typeof rig | null>(null);
  const hovered = useRef<string | null>(null);

  const nodules = useMemo(() => noduleLayout(entries).slice(0, MAX_NODULES), [entries]);
  const perRoot = useMemo(
    () =>
      MECHANISMS.map((m) => {
        const list = nodules.filter((n) => n.entry.mechanism === m.id);
        return { total: list.length, fresh: list.filter((n) => n.trust === "new").length, risky: list.filter((n) => n.trust === "risky").length };
      }),
    [nodules],
  );
  const focusIndex = focus ? MECHANISMS.findIndex((m) => m.id === focus) : -1;

  const mesh = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.Mesh>(null);
  const sphere = useMemo(() => new THREE.IcosahedronGeometry(1, 1), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      [...rig.roots, ...rig.tips].forEach((m) => m?.dispose());
    };
  }, [rig]);
  useEffect(
    () => () => {
      sphere.dispose();
      [glowMat, hitMat, haloMat].forEach((m) => m.dispose());
    },
    [sphere, glowMat, hitMat, haloMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = live.current;
    if (r) {
      perRoot.forEach((stat, i) => {
        const dim = focusIndex >= 0 && focusIndex !== i;
        const tone = stat.fresh ? palette.critical : stat.risky ? palette.warn : palette.accent;
        const rootMat = r.roots[i];
        if (rootMat) {
          rootMat.emissive.copy(focusIndex === i ? palette.accent : SAND);
          rootMat.emissiveIntensity = dim ? 0.03 : focusIndex === i ? 0.35 : 0.12;
          rootMat.opacity = dim ? 0.35 : 1;
          rootMat.transparent = dim;
        }
        const tip = r.tips[i];
        if (tip) {
          tip.emissive.copy(stat.total ? tone : palette.muted);
          const pulse = stat.fresh && animate ? 0.5 + 0.5 * Math.sin(t * 4) : 0.5;
          tip.emissiveIntensity = dim ? 0.2 : stat.fresh ? 1.6 + 1.6 * pulse : 1.8;
        }
      });
    }

    const im = mesh.current;
    const hi = hits.current;
    if (!im || !hi) return;
    nodules.forEach((n, i) => {
      const focusMe = n.entry.id === selected || n.entry.id === hovered.current;
      const dim = focusIndex >= 0 && focusIndex !== n.root;
      const off = n.entry.enabled === false;
      const pulse = n.trust === "new" && animate ? 0.5 + 0.5 * Math.sin(t * 4 + i) : 0.5;
      _q.identity();
      _p.set(...n.position);
      _s.setScalar(n.size * (focusMe ? 1.9 : n.trust === "new" ? 1 + 0.25 * pulse : 1));
      _m.compose(_p, _q, _s);
      im.setMatrixAt(i, _m);
      const strength = focusMe ? 3 : n.trust === "new" ? 2.2 + 1.8 * pulse : n.trust === "microsoft" ? 0.55 : n.trust === "unknown" ? 0.5 : 1.5;
      _c.copy(noduleColor(palette, n)).multiplyScalar(strength * (off ? 0.3 : 1) * (dim ? 0.15 : 1));
      im.setColorAt(i, _c);
      _s.setScalar(Math.max(0.06, n.size * 1.5));
      _m.compose(_p, _q, _s);
      hi.setMatrixAt(i, _m);
    });
    for (const m of [im, hi]) {
      m.count = nodules.length;
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
    }
    hi.computeBoundingSphere();

    const h = halo.current;
    const sel = selected ? nodules.find((n) => n.entry.id === selected) : undefined;
    if (h) {
      h.visible = sel !== undefined;
      if (sel) {
        h.position.set(...sel.position);
        h.scale.setScalar(sel.size * (2.6 + (animate ? 0.35 * Math.sin(t * 4) : 0)));
        h.lookAt(state.camera.position);
        haloMat.color.copy(palette.accent).multiplyScalar(2.4);
      }
    }
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) => (e.instanceId === undefined ? undefined : nodules[e.instanceId]);

  return (
    <>
      <primitive object={rig.root} />
      <instancedMesh ref={mesh} args={[sphere, glowMat, MAX_NODULES]} frustumCulled={false} raycast={() => null} />
      <mesh ref={halo} material={haloMat} visible={false} raycast={() => null}>
        <torusGeometry args={[1, 0.07, 4, 32]} />
      </mesh>
      <instancedMesh
        ref={hits}
        args={[sphere, hitMat, MAX_NODULES]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const n = pick(e);
          if (!n) return;
          hovered.current = n.entry.id;
          document.body.style.cursor = "pointer";
          onHover?.({ id: n.entry.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const n = pick(e);
          if (n) onSelect?.(n.entry.id);
        }}
      />
      {MECHANISMS.map((m, i) => {
        const [x, y, z] = rootTip(i);
        const stat = perRoot[i];
        const dim = focusIndex >= 0 && focusIndex !== i;
        return (
          <Html key={m.id} position={[x, y - 0.2, z]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
            <span className={`flex flex-col items-center whitespace-nowrap text-[11px] leading-tight transition-opacity ${dim ? "opacity-30" : ""}`}>
              <span className="font-medium">{m.short}</span>
              <span className="font-mono text-[10px] text-muted">
                {stat.total}
                {stat.fresh > 0 && <span className="ml-1 text-critical">· {stat.fresh} nouv.</span>}
                {stat.fresh === 0 && stat.risky > 0 && <span className="ml-1 text-warn">· {stat.risky} non signé{stat.risky > 1 ? "s" : ""}</span>}
              </span>
            </span>
          </Html>
        );
      })}
      {STRATA_NAMES.map((name, s) => (
        <Html key={name} position={[-3.25, (STRATA_Y[s] + STRATA_Y[s + 1]) / 2, 0.75]} zIndexRange={[4, 0]} style={{ pointerEvents: "none", transform: "translateY(-50%)" }}>
          <span className="whitespace-nowrap text-[10px] uppercase tracking-wider text-muted">{name}</span>
        </Html>
      ))}
    </>
  );
}

export default function Roots(props: RootsProps) {
  const fresh = props.entries.filter((e) => e.status !== "baseline").length;
  return (
    <Stage poster="/models/roots_poster.png" label={`Racines de persistance : ${props.entries.length} entrées qui se relancent au démarrage, ${fresh} nouvelle(s) ou modifiée(s)`} camera={<RootsCamera />} fps={30}>
      <RootsModel {...props} />
    </Stage>
  );
}
