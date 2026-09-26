"use client";

/**
 * Puce CPU 3D vivante : jumeau numérique du poste surveillé.
 *
 * Modèle généré par Blender (assets/3d/build_cpu_widget.py -> public/models/cpu_widget.glb).
 * Contrat : CPU_Core_00..11 portent userData.core_index, l'anneau utilise MAT_Ring,
 * les pistes MAT_EmitEmerald. Ce composant n'invente aucune donnée : il anime ce que lui
 * passent les props (charge par cœur, posture, trafic réseau).
 *
 * Toujours l'importer via next/dynamic({ ssr: false }).
 */

import { useEffect, useMemo, useRef } from "react";
import { useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { OrthographicCamera, useGLTF } from "@react-three/drei";
import * as THREE from "three";
import { loadTone, type CoreSlot } from "@/lib/host";
import type { PostureTone } from "@/lib/posture";
import { Stage, toneColor, useScene } from "./scene-kit";

const MODEL_URL = "/models/cpu_widget.glb";
useGLTF.preload(MODEL_URL);

export interface CoreHover {
  index: number;
  x: number;
  y: number;
}

export interface CpuChipProps {
  cores: CoreSlot[];
  posture: PostureTone;
  criticalAlerts: number;
  netBytesPerSec: number;
  onCoreHover?: (hover: CoreHover | null) => void;
  onSelect?: () => void;
}

/** Objets three.js animés impérativement : hors du modèle de données de React. */
interface Rig {
  root: THREE.Object3D;
  cores: THREE.MeshStandardMaterial[]; // indexé par core_index
  ring: THREE.MeshStandardMaterial | null;
  traces: THREE.MeshStandardMaterial | null;
  scratch: THREE.Color; // couleur de travail réutilisée à chaque image (zéro allocation)
}

/** Clone la scène glTF (le cache useGLTF est partagé) et isole les matériaux animés. */
function buildRig(scene: THREE.Group): Rig {
  const root = scene.clone(true);
  const cores: THREE.MeshStandardMaterial[] = [];
  let ring: THREE.MeshStandardMaterial | null = null;
  let traces: THREE.MeshStandardMaterial | null = null;
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    const mat = obj.material as THREE.MeshStandardMaterial;
    const coreIndex: unknown = obj.userData.core_index;
    if (typeof coreIndex === "number") {
      cores[coreIndex] = mat.clone(); // un matériau par cœur : intensité indépendante
      obj.material = cores[coreIndex];
    } else if (mat.name === "MAT_Ring") {
      ring ??= mat.clone();
      obj.material = ring;
    } else if (mat.name === "MAT_EmitEmerald") {
      traces ??= mat.clone(); // partagé par les 4 rangées de pistes
      obj.material = traces;
    }
  });
  return { root, cores, ring, traces, scratch: new THREE.Color() };
}

/** Caméra orthographique isométrique cadrée sur la puce, quelle que soit la taille du panneau. */
function IsoCamera() {
  const size = useThree((s) => s.size);
  // Empreinte isométrique de la puce en rotation (unités, petite marge incluse) :
  // ~2.95 de large et ~1.95 de haut dans le pire angle (diagonale face caméra).
  const zoom = Math.max(1, Math.min(size.width / 2.95, size.height / 1.95));
  return (
    <OrthographicCamera makeDefault position={[10, 10, 10]} zoom={zoom} near={0.1} far={50} onUpdate={(cam) => cam.lookAt(0, 0.13, 0)} />
  );
}

function ChipModel({ cores, posture, criticalAlerts, netBytesPerSec, onCoreHover, onSelect }: CpuChipProps) {
  const { palette, animate } = useScene();
  const { scene } = useGLTF(MODEL_URL);
  const rig = useMemo(() => buildRig(scene), [scene]);
  // La boucle de rendu mute les matériaux : on y accède par une ref (usage prévu des refs).
  const live = useRef<Rig | null>(null);
  const group = useRef<THREE.Group>(null);
  const hovered = useRef<number | null>(null);

  useEffect(() => {
    live.current = rig;
    return () => {
      live.current = null;
      rig.cores.forEach((m) => m.dispose());
      rig.ring?.dispose();
      rig.traces?.dispose();
    };
  }, [rig]);

  useEffect(() => () => void (document.body.style.cursor = ""), []);

  useFrame((state, delta) => {
    const r = live.current;
    if (!r) return;
    const target = r.scratch;
    const t = state.clock.elapsedTime;
    const k = 1 - Math.exp(-4 * delta); // lissage indépendant du framerate
    if (animate && group.current) group.current.rotation.y += delta * 0.18;

    // Cœurs : couleur = ton de charge (mêmes seuils que les jauges), intensité ∝ charge.
    r.cores.forEach((mat, i) => {
      const value = cores[i]?.value ?? null;
      let goal = 0.06;
      if (value === null) {
        target.copy(palette.muted);
      } else {
        target.copy(palette[loadTone(value)]);
        goal = 0.35 + (value / 100) * 2.4 + (hovered.current === i ? 0.8 : 0);
      }
      mat.emissive.lerp(target, k);
      mat.emissiveIntensity += (goal - mat.emissiveIntensity) * k;
    });

    // Anneau : couleur de la posture, pulsation s'il existe des alertes critiques.
    if (r.ring) {
      target.copy(toneColor(palette, posture));
      r.ring.emissive.lerp(target, k);
      const alarm = criticalAlerts > 0;
      const pulse = alarm && animate ? 0.5 + 0.5 * Math.sin(t * 4) : 0.5;
      r.ring.emissiveIntensity = alarm ? 1.8 + pulse * 1.6 : 2.3 + pulse * 0.2;
    }

    // Pistes : pulsation dont la cadence suit le débit réseau (échelle log, Ko/s).
    if (r.traces) {
      const speed = 0.8 + Math.min(6, Math.log10(1 + netBytesPerSec / 1024) * 1.5);
      const wave = animate ? 0.5 + 0.5 * Math.sin(t * speed) : 0.5;
      r.traces.emissiveIntensity = 0.55 + wave * 0.9;
    }
  });

  const onMove = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const raw: unknown = e.object.userData.core_index;
    const index = typeof raw === "number" ? raw : null;
    hovered.current = index;
    document.body.style.cursor = "pointer";
    onCoreHover?.(index === null ? null : { index, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY });
  };
  const onOut = () => {
    hovered.current = null;
    document.body.style.cursor = "";
    onCoreHover?.(null);
  };

  return (
    <group ref={group}>
      <primitive
        object={rig.root}
        onPointerMove={onMove}
        onPointerOut={onOut}
        onClick={(e: ThreeEvent<MouseEvent>) => {
          e.stopPropagation();
          onSelect?.();
        }}
      />
    </group>
  );
}

export default function CpuChip(props: CpuChipProps) {
  return (
    <Stage
      poster="/models/cpu_widget_poster.png"
      label="Puce CPU 3D : chaque cœur s'éclaire selon sa charge réelle, l'anneau prend la couleur de la posture de sécurité"
      camera={<IsoCamera />}
      fps={40}
    >
      <ChipModel {...props} />
    </Stage>
  );
}
