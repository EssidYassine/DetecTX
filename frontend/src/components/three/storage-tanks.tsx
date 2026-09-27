"use client";

/**
 * Réservoirs de stockage 3D : un réservoir de verre par disque, rempli d'un liquide lumineux
 * au niveau d'occupation réel. Couleur du liquide et de l'anneau = seuil de charge.
 *
 * Modèle généré par Blender (assets/3d/build_storage.py -> public/models/storage.glb), cloné
 * pour chaque disque. Contrat : MAT_TankRing, MAT_Glass ; GLASS_BOTTOM / GLASS_H / LIQUID_R
 * repris de build_storage.py.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { Html, PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import type { DiskInfo } from "@/lib/api";
import { loadTone } from "@/lib/host";
import { Stage, useScene } from "./scene-kit";

const MODEL_URL = "/models/storage.glb";
useGLTF.preload(MODEL_URL);

const GLASS_BOTTOM = 0.12;
const GLASS_H = 1.3;
const LIQUID_R = 0.33;
const SPACING = 1.15;
const MAX_TANKS = 6; // au-delà, les réservoirs deviendraient illisibles dans le panneau

export interface TankHover {
  index: number;
  x: number;
  y: number;
}

export interface StorageTanksProps {
  disks: DiskInfo[];
  onTankHover?: (hover: TankHover | null) => void;
}

interface Tank {
  root: THREE.Object3D;
  ring: THREE.MeshStandardMaterial | null;
  liquidMat: THREE.MeshStandardMaterial;
  surfaceMat: THREE.MeshBasicMaterial;
}

/** Clone le réservoir Blender ; le verre est dessiné après le liquide (renderOrder). */
function buildTank(scene: THREE.Group): Tank {
  const root = scene.clone(true);
  let ring: THREE.MeshStandardMaterial | null = null;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mats = (Array.isArray(obj.material) ? obj.material : [obj.material]) as THREE.MeshStandardMaterial[];
    const cloned = mats.map((m) => {
      if (m.name === "MAT_TankRing") return (ring ??= m.clone());
      if (m.name === "MAT_Glass") {
        obj.renderOrder = 2;
        m.depthWrite = false;
      }
      return m;
    });
    obj.material = Array.isArray(obj.material) ? cloned : cloned[0];
  });
  return {
    root,
    ring,
    liquidMat: new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.82, roughness: 0.25, metalness: 0 }),
    surfaceMat: new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95, toneMapped: false }),
  };
}

const tankX = (i: number, n: number) => (i - (n - 1) / 2) * SPACING;

function TanksCamera({ count }: { count: number }) {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 30;
  const half = THREE.MathUtils.degToRad(fov / 2);
  const halfW = Math.max(0.85, (count * SPACING) / 2 + 0.15);
  const dist = Math.max(halfW / (Math.tan(half) * aspect), 1.02 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.34, 0.94).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={40}
      position={[dir.x * dist, 0.72 + dir.y * dist, dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.72, 0)}
    />
  );
}

function TanksModel({ disks, onTankHover }: StorageTanksProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const shown = disks.slice(0, MAX_TANKS);
  const count = shown.length;
  const tanks = useMemo(() => Array.from({ length: count }, () => buildTank(scene)), [scene, count]);
  const live = useRef<Tank[]>([]);
  const liquids = useRef<(THREE.Mesh | null)[]>([]);
  const surfaces = useRef<(THREE.Mesh | null)[]>([]);
  const levels = useRef<number[]>([]);
  const hovered = useRef<number | null>(null);

  const liquidGeo = useMemo(() => new THREE.CylinderGeometry(LIQUID_R, LIQUID_R, 1, 40).translate(0, 0.5, 0), []);
  const surfaceGeo = useMemo(() => new THREE.CircleGeometry(LIQUID_R, 40).rotateX(-Math.PI / 2), []);

  useEffect(() => {
    live.current = tanks;
    return () => {
      live.current = [];
      tanks.forEach((t) => {
        t.ring?.dispose();
        t.liquidMat.dispose();
        t.surfaceMat.dispose();
      });
    };
  }, [tanks]);
  useEffect(
    () => () => {
      liquidGeo.dispose();
      surfaceGeo.dispose();
    },
    [liquidGeo, surfaceGeo],
  );
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    const k = 1 - Math.exp(-3 * delta);
    live.current.forEach((tank, i) => {
      const disk = shown[i];
      if (!disk) return;
      const color = palette[loadTone(disk.percent)];
      const focus = hovered.current === i;
      const goal = GLASS_H * THREE.MathUtils.clamp(disk.percent / 100, 0.004, 0.985);
      levels.current[i] = (levels.current[i] ?? 0.01) + (goal - (levels.current[i] ?? 0.01)) * k;
      const level = levels.current[i];
      // Ondulation de surface : le liquide « vit » sans fausser le niveau (±0.5 %).
      const ripple = animate ? Math.sin(t * 2.2 + i * 1.7) * 0.006 : 0;

      const liquid = liquids.current[i];
      if (liquid) liquid.scale.y = level + ripple;
      const surface = surfaces.current[i];
      if (surface) surface.position.y = GLASS_BOTTOM + level + ripple + 0.002;

      tank.liquidMat.color.copy(color).multiplyScalar(0.3);
      tank.liquidMat.emissive.copy(color);
      tank.liquidMat.emissiveIntensity = focus ? 1.1 : 0.7;
      tank.surfaceMat.color.copy(color).multiplyScalar(focus ? 3.6 : 2.4);
      if (tank.ring) {
        tank.ring.emissive.lerp(color, k);
        tank.ring.emissiveIntensity = focus ? 3.2 : 2.2;
      }
    });
  });

  const onMove = (i: number) => (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    hovered.current = i;
    document.body.style.cursor = "help";
    onTankHover?.({ index: i, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onTankHover?.(null);
  };

  return (
    <>
      {tanks.map((tank, i) => (
        <group key={i} position={[tankX(i, count), 0, 0]} onPointerMove={onMove(i)} onPointerOut={onOut}>
          <primitive object={tank.root} />
          <mesh
            ref={(m: THREE.Mesh | null) => void (liquids.current[i] = m)}
            geometry={liquidGeo}
            material={tank.liquidMat}
            position={[0, GLASS_BOTTOM, 0]}
            renderOrder={1}
          />
          <mesh
            ref={(m: THREE.Mesh | null) => void (surfaces.current[i] = m)}
            geometry={surfaceGeo}
            material={tank.surfaceMat}
            renderOrder={1}
          />
          <Html position={[0, -0.04, 0.55]} center zIndexRange={[5, 0]} style={{ pointerEvents: "none" }}>
            <span className="whitespace-nowrap font-mono text-[10px] tracking-wide text-muted">
              {shown[i]?.mount} <span style={{ color: `var(--${loadTone(shown[i]?.percent ?? 0)})` }}>{Math.round(shown[i]?.percent ?? 0)}%</span>
            </span>
          </Html>
        </group>
      ))}
    </>
  );
}

export default function StorageTanks(props: StorageTanksProps) {
  const count = Math.min(props.disks.length, MAX_TANKS);
  return (
    <Stage
      poster="/models/storage_poster.png"
      label={`Réservoirs de stockage 3D : ${props.disks.map((d) => `${d.mount} ${Math.round(d.percent)} %`).join(", ") || "aucun disque"}`}
      camera={<TanksCamera count={Math.max(1, count)} />}
      fps={24}
    >
      <TanksModel {...props} />
    </Stage>
  );
}
