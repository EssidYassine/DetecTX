"""
build_dial.py - Cadran 24 h 3D de l'Overview DeTecTX.

Un disque-horloge (00 h en haut, sens horaire) : anneau neon, 24 graduations, chiffres
00/06/12/18, moyeu lumineux et aiguille. Le web y dresse une colonne lumineuse par heure
(volume d'evenements) et fait tourner l'aiguille sur l'heure courante.

Usage : blender --background --python assets/3d/build_dial.py

Contrat avec le composant web (frontend/src/components/three/activity-dial.tsx) :
    Dial_Widget (racine), Dial_Needle (pointe vers 00 h au repos, origine au centre),
    MAT_DialRing / MAT_Hub (teinte accent du theme), COLUMN_RADIUS et FLOOR_Z ci-dessous.
"""

import math
import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

DIAL_R, DIAL_H = 2.0, 0.1
RECESS = 0.015
FLOOR_Z = DIAL_H - RECESS  # 0.085 : plancher ou le web pose les colonnes
COLUMN_RADIUS = 1.35
TICK_RADIUS = 1.8
LABEL_RADIUS = 1.56


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ring"] = dtx3d.make_material("MAT_DialRing", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.2)
    mats["floor"] = dtx3d.make_material("MAT_DialFloor", "#03100d", roughness=0.18)
    mats["hub"] = dtx3d.make_material("MAT_Hub", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.5)
    mats["needle"] = dtx3d.make_material("MAT_Needle", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=2.5)
    mats["label"] = dtx3d.make_material("MAT_DialLabel", "#000000", roughness=0.4, emission="#8a97a9", strength=0.9)
    return mats


def build_base(mats):
    """Disque : bordure metal, anneau neon, plancher en retrait."""
    bm = dtx3d.cylinder_bmesh(DIAL_R, DIAL_H, (0.0, 0.0, DIAL_H / 2), segments=96)
    top = dtx3d.top_face(bm)
    bmesh.ops.inset_region(bm, faces=[top], thickness=0.1, depth=0.0, use_even_offset=True)
    ring = bmesh.ops.inset_region(bm, faces=[top], thickness=0.02, depth=0.0, use_even_offset=True)["faces"]
    for f in ring:
        f.material_index = 1
    ret = bmesh.ops.extrude_face_region(bm, geom=[top])
    new_verts = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=Vector((0.0, 0.0, -RECESS)), verts=new_verts)
    bmesh.ops.delete(bm, geom=[top], context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z > 0.9 and f.calc_center_median().z < DIAL_H - 0.005:
            f.material_index = 2
    ob = dtx3d.object_from_bmesh("Dial_Base", bm, [mats["metal"], mats["ring"], mats["floor"]])
    dtx3d.add_bevel(ob, 0.012)
    dtx3d.smooth_by_angle(ob)
    return ob


def build_ticks(mats):
    """24 graduations radiales (heures majeures 00/06/12/18 plus longues), un seul maillage."""
    bm = bmesh.new()
    for h in range(24):
        major = h % 6 == 0
        length, width = (0.2, 0.04) if major else (0.1, 0.022)
        theta = h / 24 * 2 * math.pi  # 00 h en haut (+Y), sens horaire vu du dessus
        pos = Vector((math.sin(theta) * TICK_RADIUS, math.cos(theta) * TICK_RADIUS, FLOOR_Z + 0.009))
        transform = Matrix.Translation(pos) @ Matrix.Rotation(-theta, 4, "Z") @ Matrix.Diagonal((width, length, 0.018, 1.0))
        bmesh.ops.create_cube(bm, size=1.0, matrix=transform)
    return dtx3d.object_from_bmesh("Dial_Ticks", bm, [mats["metal_light"]])


def build_labels(mats):
    labels = []
    for h in (0, 6, 12, 18):
        theta = h / 24 * 2 * math.pi
        pos = (math.sin(theta) * LABEL_RADIUS, math.cos(theta) * LABEL_RADIUS, FLOOR_Z + 0.002)
        labels.append(dtx3d.text_mesh(f"Dial_Label_{h:02d}", f"{h:02d}", 0.17, pos, mats["label"]))
    return labels


def build_hub_and_needle(mats):
    """Moyeu 'maintenant' + aiguille (pointe vers 00 h au repos, origine au centre du cadran)."""
    bm = dtx3d.cylinder_bmesh(0.3, 0.16, (0.0, 0.0, FLOOR_Z + 0.08), segments=48)
    top = dtx3d.top_face(bm)
    bmesh.ops.inset_region(bm, faces=[top], thickness=0.06, depth=0.0, use_even_offset=True)
    top.material_index = 1  # après l'inset, `top` est le disque central : il devient lumineux
    hub = dtx3d.object_from_bmesh("Dial_Hub", bm, [mats["metal"], mats["hub"]])
    dtx3d.add_bevel(hub, 0.01)

    length = 1.18 - 0.3
    needle = dtx3d.object_from_bmesh(
        "Dial_Needle",
        dtx3d.box_bmesh((0.035, length, 0.025), (0.0, 0.3 + length / 2, FLOOR_Z + 0.13)),
        [mats["needle"]],
    )
    return [hub, needle]


def main():
    scene = dtx3d.reset_scene()
    mats = build_materials()
    parts = [build_base(mats), build_ticks(mats)] + build_labels(mats) + build_hub_and_needle(mats)
    dtx3d.root_empty("Dial_Widget", parts)

    dtx3d.camera_persp(scene, location=(0.0, -4.8, 4.4), target=(0.0, 0.15, 0.0), lens=42)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.1), scale=1.4)
    dtx3d.finish("dial", __file__, scene, parts)


if __name__ == "__main__":
    main()
