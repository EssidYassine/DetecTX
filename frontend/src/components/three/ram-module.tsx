"use client";

/**
 * Barrette mémoire 3D : 8 puces = 8 huitièmes de la RAM, allumées de gauche à droite selon
 * l'occupation réelle (la dernière puce s'allume partiellement). Couleur = seuil de charge.
 *
 * Modèle généré par Blender (assets/3d/build_ram.py -> public/models/ram.glb).
 * Contrat : RAM_Chip_0..7 portent userData.chip_index, matériau MAT_RamChip.
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { PerspectiveCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { loadTone } from "@/lib/host";
import { Stage, useScene } from "./scene-kit";

const MODEL_URL = "/models/ram.glb";
useGLTF.preload(MODEL_URL);

export const RAM_CHIPS = 8;

export interface ChipHover {
  index: number;
  x: number;
  y: number;
}

export interface RamModuleProps {
  percent: number | null; // null = pas encore de mesure
  onChipHover?: (hover: ChipHover | null) => void;
}

/** Remplissage d'une puce (0..1) : la RAM est découpée en 8 tranches égales. */
export function chipFill(percent: number, index: number): number {
  return THREE.MathUtils.clamp((percent / 100) * RAM_CHIPS - index, 0, 1);
}

interface Rig {
  root: THREE.Object3D;
  chips: THREE.MeshStandardMaterial[]; // indexé par chip_index
  scratch: THREE.Color;
}

function buildRig(scene: THREE.Group): Rig {
  const root = scene.clone(true);
  const chips: THREE.MeshStandardMaterial[] = [];
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const index: unknown = obj.userData.chip_index;
    if (typeof index === "number") {
      chips[index] = (obj.material as THREE.MeshStandardMaterial).clone();
      obj.material = chips[index];
    }
  });
  return { root, chips, scratch: new THREE.Color() };
}

function RamCamera() {
  const size = useThree((s) => s.size);
  const aspect = size.width / Math.max(1, size.height);
  const fov = 30;
  const half = THREE.MathUtils.degToRad(fov / 2);
  // Emprise : barrette + loquets ~2.9 de large, ~0.9 de haut vue de trois quarts.
  const dist = Math.max(1.85 / (Math.tan(half) * aspect), 0.66 / Math.tan(half));
  const dir = new THREE.Vector3(0, 0.36, 0.93).normalize();
  return (
    <PerspectiveCamera
      makeDefault
      fov={fov}
      near={0.1}
      far={40}
      position={[dir.x * dist, 0.42 + dir.y * dist, dir.z * dist]}
      onUpdate={(cam) => cam.lookAt(0, 0.42, 0)}
    />
  );
}

function RamModel({ percent, onChipHover }: RamModuleProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => buildRig(scene), [scene]);
  const live = useRef<Rig | null>(null);
  const group = useRef<THREE.Group>(null);
  const hovered = useRef<number | null>(null);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.chips.forEach((m) => m.dispose());
    };
  }, [rig]);
  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const r = live.current;
    if (!r) return;
    const t = state.clock.elapsedTime;
    const k = 1 - Math.exp(-4 * delta);
    // Léger balancement : la barrette « respire » sans jamais sortir du cadre.
    if (group.current) group.current.rotation.y = animate ? Math.sin(t * 0.35) * 0.12 : 0;

    const tone = percent === null ? palette.muted : palette[loadTone(percent)];
    r.chips.forEach((mat, i) => {
      const fill = percent === null ? 0 : chipFill(percent, i);
      // Onde de lecture/écriture qui parcourt les puces occupées.
      const wave = animate && fill > 0 ? 0.25 * (0.5 + 0.5 * Math.sin(t * 3 - i * 0.9)) : 0;
      const goal = fill > 0 ? 0.35 + fill * 2.2 + wave + (hovered.current === i ? 0.9 : 0) : hovered.current === i ? 0.4 : 0.05;
      r.scratch.copy(fill > 0 ? tone : palette.muted);
      mat.emissive.lerp(r.scratch, k);
      mat.emissiveIntensity += (goal - mat.emissiveIntensity) * k;
    });
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    const raw: unknown = e.object.userData.chip_index;
    if (typeof raw !== "number") return;
    e.stopPropagation();
    hovered.current = raw;
    document.body.style.cursor = "help";
    onChipHover?.({ index: raw, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onChipHover?.(null);
  };

  return (
    <group ref={group}>
      <primitive object={rig.root} onPointerMove={onMove} onPointerOut={onOut} />
    </group>
  );
}

export default function RamModule(props: RamModuleProps) {
  return (
    <Stage
      poster="/models/ram_poster.png"
      label={`Barrette mémoire 3D : ${props.percent === null ? "mesure en cours" : `${Math.round(props.percent)} % de la RAM occupée`}, une puce par huitième de mémoire`}
      camera={<RamCamera />}
      fps={30}
    >
      <RamModel {...props} />
    </Stage>
  );
}
