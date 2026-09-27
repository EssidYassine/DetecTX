"""
build_rampart.py - « Rempart » : le poste et son pare-feu (page Systeme, vue Ports).

Au centre un donjon (le poste), autour une cour interieure (services locaux, lies a
127.0.0.1), puis une enceinte de verre a liseré neon : le pare-feu Windows. Au-dela, le
reseau. Le web pose une porte dans l'enceinte par port lie au reseau : scellee (bloquee par
le pare-feu) ou ouverte avec un faisceau vers l'exterieur (joignable), et une tourelle dans la
cour par service local.

Usage : blender --background --python assets/3d/build_rampart.py

Contrat avec le composant web (frontend/src/components/three/rampart.tsx) :
    Rampart_Widget (racine), MAT_ShieldRim (liseré du pare-feu, teinte selon son etat).
    WALL_R / WALL_H / LOCAL_R / GROUND_TOP / OUTER_R ci-dessous : repris par le composant.
"""

import math
import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

PLATE_R, PLATE_H = 3.5, 0.1
GROUND_TOP = 0.11
WALL_R, WALL_H = 2.2, 0.5
LOCAL_R = 1.25
OUTER_R = 3.25


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_RampGround", "#07120f", roughness=0.85)
    mats["court"] = dtx3d.make_material("MAT_Court", "#0c1d19", roughness=0.7)
    mats["shield"] = dtx3d.make_material("MAT_Shield", "#2dd4bf", roughness=0.1, emission=dtx3d.ACCENT, strength=0.15, alpha=0.12)
    mats["rim"] = dtx3d.make_material("MAT_ShieldRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.2)
    mats["keep"] = dtx3d.make_material("MAT_Keep", "#000000", roughness=0.3, emission=dtx3d.ACCENT, strength=2.6)
    mats["grid"] = dtx3d.make_material("MAT_RampGrid", "#000000", roughness=0.4, emission="#8a97a9", strength=0.12)
    mats["local"] = dtx3d.make_material("MAT_LocalRing", "#000000", roughness=0.4, emission="#8a97a9", strength=0.3)
    return mats


def open_tube(radius, height, z0, segments=128) -> bmesh.types.BMesh:
    """Cylindre sans couvercles : la paroi de l'enceinte."""
    bm = dtx3d.cylinder_bmesh(radius, height, (0.0, 0.0, z0 + height / 2), segments=segments)
    caps = [f for f in bm.faces if abs(f.normal.z) > 0.9]
    bmesh.ops.delete(bm, geom=caps, context="FACES_ONLY")
    return bm


def build(mats):
    parts = []
    plate = dtx3d.object_from_bmesh("Rampart_Plate", dtx3d.cylinder_bmesh(PLATE_R, PLATE_H, (0.0, 0.0, PLATE_H / 2), segments=96), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(dtx3d.object_from_bmesh("Rampart_Ground", dtx3d.cylinder_bmesh(PLATE_R - 0.15, 0.01, (0.0, 0.0, PLATE_H + 0.005), segments=96), [mats["ground"]]))
    parts.append(dtx3d.object_from_bmesh("Rampart_Court", dtx3d.cylinder_bmesh(WALL_R - 0.06, 0.012, (0.0, 0.0, PLATE_H + 0.012), segments=96), [mats["court"]]))
    parts.append(dtx3d.object_from_bmesh("Rampart_LocalRing", dtx3d.torus_bmesh(LOCAL_R, 0.006, (0.0, 0.0, GROUND_TOP + 0.01), 96, 4), [mats["local"]]))

    # Le reseau exterieur : rayons discrets entre l'enceinte et le bord du plateau.
    bm = bmesh.new()
    spokes = 36
    inner, outer = WALL_R + 0.25, OUTER_R
    for i in range(spokes):
        angle = 2 * math.pi * i / spokes
        mid = (inner + outer) / 2
        bmesh.ops.create_cube(
            bm,
            size=1.0,
            matrix=Matrix.Translation(Vector((math.cos(angle) * mid, math.sin(angle) * mid, GROUND_TOP)))
            @ Matrix.Rotation(angle, 4, "Z")
            @ Matrix.Diagonal((outer - inner, 0.007, 0.004, 1.0)),
        )
    parts.append(dtx3d.object_from_bmesh("Rampart_Grid", bm, [mats["grid"]]))

    # L'enceinte : paroi de verre + socle metal + liseré neon (le pare-feu).
    parts.append(dtx3d.object_from_bmesh("Rampart_Wall", open_tube(WALL_R, WALL_H, GROUND_TOP), [mats["shield"]]))
    parts.append(dtx3d.object_from_bmesh("Rampart_WallBase", dtx3d.torus_bmesh(WALL_R, 0.035, (0.0, 0.0, GROUND_TOP + 0.02), 128, 6), [mats["metal"]]))
    parts.append(dtx3d.object_from_bmesh("Rampart_Rim", dtx3d.torus_bmesh(WALL_R, 0.014, (0.0, 0.0, GROUND_TOP + WALL_H), 128, 6), [mats["rim"]]))

    # Le donjon : le poste surveille.
    keep = dtx3d.object_from_bmesh("Rampart_Keep", dtx3d.cylinder_bmesh(0.36, 0.6, (0.0, 0.0, GROUND_TOP + 0.3), segments=8), [mats["metal_light"]])
    dtx3d.add_bevel(keep, 0.015)
    parts.append(keep)
    parts.append(dtx3d.object_from_bmesh("Rampart_KeepTop", dtx3d.cylinder_bmesh(0.28, 0.04, (0.0, 0.0, GROUND_TOP + 0.62), segments=8), [mats["keep"]]))
    bm = bmesh.new()
    for i in range(8):  # creneaux
        angle = 2 * math.pi * (i + 0.5) / 8
        bmesh.ops.create_cube(
            bm,
            size=1.0,
            matrix=Matrix.Translation(Vector((math.cos(angle) * 0.33, math.sin(angle) * 0.33, GROUND_TOP + 0.66)))
            @ Matrix.Rotation(angle, 4, "Z")
            @ Matrix.Diagonal((0.07, 0.12, 0.1, 1.0)),
        )
    battlements = dtx3d.object_from_bmesh("Rampart_Battlements", bm, [mats["metal_light"]])
    parts.append(battlements)
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Rampart_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -8.6, 6.6), target=(0.0, 0.0, 0.1), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=1.8)
    dtx3d.finish("rampart", __file__, scene, parts, preview_res=(1400, 800), poster_res=(1000, 570))


if __name__ == "__main__":
    main()
