"use client";

/**
 * « La Ruche ATT&CK » 3D : 15 quartiers hexagonaux (tactiques v19, ordre de la kill chain en
 * serpentin), une alvéole par technique Windows.
 *   enveloppe de verre = règles THÉORIQUES (si toutes les sources étaient collectées) ;
 *   noyau lumineux    = règles RÉELLEMENT actives (source collectée) : l'écart est l'angle mort ;
 *   verre ambré sans noyau = technique couverte en théorie seulement ; alvéole sombre = aucune règle ;
 *   coiffe rouge (ouverte) / ambre = technique observée dans des alertes.
 * Le simulateur change les sources : les noyaux montent ou descendent en douceur.
 *
 * Modèle généré par Blender (assets/3d/build_hive.py -> public/models/hive.glb).
 * Contrat : Pad_00..14 / PadRim_00..14 (userData.tactic_index), MAT_PadRim, MAT_HivePath ;
 * constantes HIVE (lib/attack.ts).
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, type ThreeEvent } from "@react-three/fiber";
import { Html, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { MitreCoverage } from "@/lib/api";
import { effectiveWith, HIVE, hiveLayout, padCenter, tacticLabel, tacticShort, type Cell } from "@/lib/attack";
import { boxPoints, FitCamera, Stage, useScene } from "./scene-kit";

const MODEL_URL = "/models/hive.glb";
useGLTF.preload(MODEL_URL);

const MAX_CELLS = 640;
const VIEW_POINTS = boxPoints(8.95, 5.1, 0, 1.15);

export interface HiveHover {
  id: string;
  x: number;
  y: number;
}

export interface HiveProps {
  coverage: MitreCoverage;
  sources: ReadonlySet<string>; // sources collectées + simulées
  selected: string | null;
  highlight: ReadonlySet<string> | null; // résultats de recherche (les autres s'estompent)
  onHover?: (hover: HiveHover | null) => void;
  onSelect?: (id: string) => void;
}

function HiveCamera() {
  // Vue assez rasante : la différence de hauteur verre / noyau (l'angle mort) doit se lire.
  return <FitCamera points={VIEW_POINTS} direction={[0, 0.5, 0.87]} fov={30} margin={0.03} />;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();

function HiveModel({ coverage, sources, selected, highlight, onHover, onSelect }: HiveProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => {
    const root = scene.clone(true);
    const rims: (THREE.MeshStandardMaterial | null)[] = Array(15).fill(null);
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const index: unknown = obj.userData.tactic_index ?? obj.parent?.userData.tactic_index;
      if (typeof index === "number" && (obj.material as THREE.Material).name === "MAT_PadRim") {
        rims[index] = (obj.material as THREE.MeshStandardMaterial).clone();
        obj.material = rims[index]!;
      }
    });
    return { root, rims };
  }, [scene]);
  const live = useRef<typeof rig | null>(null);
  const hovered = useRef<string | null>(null);

  const tacticIds = useMemo(() => coverage.tactics.map((t) => t.id), [coverage.tactics]);
  const cells = useMemo<Cell[]>(() => hiveLayout(coverage.techniques, tacticIds).slice(0, MAX_CELLS), [coverage.techniques, tacticIds]);
  const maxT = useMemo(() => Math.max(1, ...cells.map((c) => c.t.theoretical)), [cells]);
  const height = (n: number) => (n > 0 ? 0.06 + 0.9 * Math.sqrt(n / maxT) : 0);

  // Cibles (dépendent du simulateur) et hauteurs courantes animées vers elles.
  const targets = useMemo(() => cells.map((c) => ({ shell: Math.max(0.035, height(c.t.theoretical)), core: height(effectiveWith(c.t, sources)) })), [cells, sources, maxT]); // eslint-disable-line react-hooks/exhaustive-deps
  const current = useRef<Float32Array>(new Float32Array(0));

  // Couverture par quartier (liseré) : part des techniques théoriques réellement couvertes.
  const districtRatio = useMemo(
    () =>
      tacticIds.map((id) => {
        const group = coverage.techniques.filter((t) => t.district === id && t.theoretical > 0);
        return group.length ? group.filter((t) => effectiveWith(t, sources) > 0).length / group.length : 0;
      }),
    [coverage.techniques, tacticIds, sources],
  );

  const shells = useRef<THREE.InstancedMesh>(null);
  const cores = useRef<THREE.InstancedMesh>(null);
  const caps = useRef<THREE.InstancedMesh>(null);
  const hits = useRef<THREE.InstancedMesh>(null);
  const halo = useRef<THREE.Mesh>(null);

  const hexGeo = useMemo(() => new THREE.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0), []);
  const capGeo = useMemo(() => new THREE.CylinderGeometry(1, 1, 0.025, 6), []);
  const hitGeo = useMemo(() => new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0), []);
  const glassMat = useMemo(() => new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.32, roughness: 0.15, metalness: 0.1, depthWrite: false }), []);
  const glowMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);
  const hitMat = useMemo(() => new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }), []);
  const haloMat = useMemo(() => new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), []);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.rims.forEach((m) => m?.dispose());
    };
  }, [rig]);
  useEffect(
    () => () => {
      [hexGeo, capGeo, hitGeo].forEach((g) => g.dispose());
      [glassMat, glowMat, hitMat, haloMat].forEach((m) => m.dispose());
    },
    [hexGeo, capGeo, hitGeo, glassMat, glowMat, hitMat, haloMat],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state) => {
    const t = state.clock.elapsedTime;
    const r = live.current;
    if (r) {
      r.rims.forEach((mat, i) => {
        if (!mat) return;
        const ratio = districtRatio[i] ?? 0;
        mat.emissive.copy(ratio >= 0.5 ? palette.accent : ratio >= 0.2 ? palette.warn : palette.critical);
        mat.emissiveIntensity = 0.5 + 1.6 * ratio;
      });
    }
    const sh = shells.current;
    const co = cores.current;
    const ca = caps.current;
    const hi = hits.current;
    if (!sh || !co || !ca || !hi) return;
    if (current.current.length !== cells.length * 2) {
      current.current = new Float32Array(cells.length * 2); // départ à plat : la ruche « pousse » à l'ouverture
    }
    const cur = current.current;
    let nCap = 0;
    cells.forEach((c, i) => {
      const k = animate ? 0.12 : 1;
      cur[i * 2] += (targets[i].shell - cur[i * 2]) * k;
      cur[i * 2 + 1] += (targets[i].core - cur[i * 2 + 1]) * k;
      const shellH = cur[i * 2];
      const coreH = cur[i * 2 + 1];
      const focus = c.t.id === selected || c.t.id === hovered.current;
      const dim = highlight !== null && !highlight.has(c.t.id);
      const s = c.size * (focus ? 1.12 : 1);

      _q.identity();
      _p.set(c.x, HIVE.PAD_TOP, c.z);
      _s.set(s, shellH, s);
      _m.compose(_p, _q, _s);
      sh.setMatrixAt(i, _m);
      if (c.t.theoretical === 0) _c.copy(palette.muted).multiplyScalar(0.28);
      else if (coreH < 0.01) _c.copy(palette.warn).multiplyScalar(0.85); // angle mort : couvert en théorie seulement
      else _c.copy(palette.accent).multiplyScalar(0.55);
      if (focus) _c.multiplyScalar(1.8);
      if (dim) _c.multiplyScalar(0.25);
      sh.setColorAt(i, _c);

      _s.set(s * 0.6, Math.max(coreH, 0.0001), s * 0.6);
      _m.compose(_p, _q, _s);
      co.setMatrixAt(i, _m);
      _c.copy(palette.accent).multiplyScalar(dim ? 0.4 : focus ? 3.2 : 2.1);
      co.setColorAt(i, _c);

      if (c.t.alerts > 0) {
        const pulse = animate && c.t.alerts_open > 0 ? 0.5 + 0.5 * Math.sin(t * 4 + i) : 0.6;
        _p.set(c.x, HIVE.PAD_TOP + shellH + 0.03, c.z);
        _s.set(s * 1.05, 1, s * 1.05);
        _m.compose(_p, _q, _s);
        ca.setMatrixAt(nCap, _m);
        _c.copy(c.t.alerts_open > 0 ? palette.critical : palette.warn).multiplyScalar(2 + 2.5 * pulse);
        ca.setColorAt(nCap++, _c);
      }

      _p.set(c.x, HIVE.PAD_TOP, c.z);
      _s.set(c.size * 1.7, shellH + 0.08, c.size * 1.7);
      _m.compose(_p, _q, _s);
      hi.setMatrixAt(i, _m);
    });
    for (const [mesh, n] of [[sh, cells.length], [co, cells.length], [ca, nCap], [hi, cells.length]] as const) {
      mesh.count = n;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    hi.computeBoundingSphere();

    const h = halo.current;
    const sel = selected ? cells.findIndex((c) => c.t.id === selected) : -1;
    if (h) {
      h.visible = sel >= 0;
      if (sel >= 0) {
        const c = cells[sel];
        h.position.set(c.x, HIVE.PAD_TOP + 0.01, c.z);
        h.scale.setScalar(c.size * (1.5 + (animate ? 0.15 * Math.sin(t * 4) : 0)));
        haloMat.color.copy(palette.accent).multiplyScalar(2.6);
      }
    }
  });

  const pick = (e: ThreeEvent<PointerEvent> | ThreeEvent<MouseEvent>) => (e.instanceId === undefined ? undefined : cells[e.instanceId]);
  const selectedCell = selected ? cells.find((c) => c.t.id === selected) : undefined;

  return (
    <>
      <primitive object={rig.root} />
      <instancedMesh ref={shells} args={[hexGeo, glassMat, MAX_CELLS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={cores} args={[hexGeo, glowMat, MAX_CELLS]} frustumCulled={false} raycast={() => null} />
      <instancedMesh ref={caps} args={[capGeo, glowMat, MAX_CELLS]} frustumCulled={false} raycast={() => null} />
      <mesh ref={halo} material={haloMat} rotation-x={Math.PI / 2} visible={false} raycast={() => null}>
        <torusGeometry args={[1, 0.06, 4, 6]} />
      </mesh>
      <instancedMesh
        ref={hits}
        args={[hitGeo, hitMat, MAX_CELLS]}
        frustumCulled={false}
        onPointerMove={(e: ThreeEvent<PointerEvent>) => {
          e.stopPropagation();
          const c = pick(e);
          if (!c) return;
          hovered.current = c.t.id;
          document.body.style.cursor = "pointer";
          onHover?.({ id: c.t.id, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
        }}
        onPointerOut={() => {
          hovered.current = null;
          document.body.style.cursor = "";
          onHover?.(null);
        }}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          const c = pick(e);
          if (c) onSelect?.(c.t.id);
        }}
      />
      {tacticIds.map((id, i) => {
        const [x, z] = padCenter(i);
        const group = coverage.techniques.filter((t) => t.district === id && t.theoretical > 0);
        const covered = group.filter((t) => effectiveWith(t, sources) > 0).length;
        return (
          <Html key={id} position={[x, HIVE.PAD_TOP, z - HIVE.PAD_R - 0.12]} center zIndexRange={[4, 0]} style={{ pointerEvents: "none" }}>
            <span className="whitespace-nowrap rounded bg-surface/70 px-1 text-center text-[10px] font-medium leading-tight text-muted" title={tacticLabel(id)}>
              {tacticShort(id)}
              <span className="ml-1 font-mono tabular-nums text-foreground/80">
                {covered}/{group.length}
              </span>
            </span>
          </Html>
        );
      })}
      {selectedCell && (
        <Html position={[selectedCell.x, HIVE.PAD_TOP + 1.25, selectedCell.z]} center zIndexRange={[6, 0]} style={{ pointerEvents: "none" }}>
          <span className="whitespace-nowrap rounded bg-accent px-1.5 py-0.5 font-mono text-[10px] font-semibold text-accent-fg shadow">{selectedCell.t.id}</span>
        </Html>
      )}
    </>
  );
}

export default function Hive(props: HiveProps) {
  const t = props.coverage.totals;
  return (
    <Stage
      poster="/models/hive_poster.png"
      label={`Ruche ATT&CK : ${t.techniques_effective} techniques réellement couvertes sur ${t.techniques_theoretical} couvertes en théorie`}
      camera={<HiveCamera />}
      fps={30}
    >
      <HiveModel {...props} />
    </Stage>
  );
}
