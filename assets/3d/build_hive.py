"""
build_hive.py - « La Ruche ATT&CK » de la page MITRE DeTecTX.

Un plateau en nid d'abeille : 15 quartiers hexagonaux, un par tactique ATT&CK (v19), poses en
5 x 3 dans l'ordre de la kill chain (lecture comme un texte : arriere-gauche -> avant-droite),
relies par un chemin lumineux en serpentin. Le web y pose une alveole hexagonale par technique :
enveloppe de verre = regles theoriques, noyau lumineux = regles reellement actives.

Usage : blender --background --python assets/3d/build_hive.py

Contrat avec le composant web (frontend/src/components/three/hive.tsx) :
    Hive_Widget (racine), Pad_00..14 (MAT_Pad) et PadRim_00..14 (MAT_PadRim, userData.tactic_index),
    Hive_Path (MAT_HivePath), Hive_Rim (MAT_HiveRim).
    Constantes : GROUND_TOP, PAD_R, COLS, DX, DZ (positions des quartiers : pad_center()).

Reperes : (x, z) dans le repere three.js ; Blender -> three : (x, y, z) -> (x, z, -y).
"""

import math
import os
import sys

import bmesh
import bpy

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

TACTICS = 15
COLS, ROWS = 5, 3
DX, DZ = 3.4, 3.1
PAD_R = 1.48  # rayon (sommet) d'un quartier hexagonal
PLATE_H = 0.1
GROUND_TOP = 0.11
PAD_H = 0.03


def pad_center(i: int) -> tuple[float, float]:
    """Serpentin : ligne 0 de gauche a droite (au fond), ligne 1 de droite a gauche, ligne 2 de gauche a droite."""
    row, col = divmod(i, COLS)
    if row % 2 == 1:
        col = COLS - 1 - col
    return ((col - (COLS - 1) / 2) * DX, (row - (ROWS - 1) / 2) * DZ)


def bl(x: float, z: float, h: float) -> tuple:
    return (x, -z, h)


def hexagon(cx: float, cz: float, r: float, h: float) -> list[tuple]:
    """Sommets d'un hexagone « pointe en haut » (vu de dessus), repere three."""
    return [bl(cx + r * math.cos(math.pi / 6 + k * math.pi / 3), cz + r * math.sin(math.pi / 6 + k * math.pi / 3), h) for k in range(6)]


def tube(name: str, points: list[tuple], radius: float, material, cyclic: bool = False):
    curve = bpy.data.curves.new(name + "_Curve", "CURVE")
    curve.dimensions = "3D"
    curve.bevel_depth = radius
    curve.bevel_resolution = 1
    spline = curve.splines.new("POLY")
    spline.points.add(len(points) - 1)
    for pt, co in zip(spline.points, points):
        pt.co = (*co, 1.0)
    spline.use_cyclic_u = cyclic
    tmp = dtx3d.link(bpy.data.objects.new(name + "_Tmp", curve))
    mesh = bpy.data.meshes.new_from_object(tmp.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(tmp, do_unlink=True)
    bpy.data.curves.remove(curve)
    mesh.materials.append(material)
    return dtx3d.link(bpy.data.objects.new(name, mesh))


def hex_prism(cx: float, cz: float, r: float, z0: float, h: float) -> bmesh.types.BMesh:
    bm = bmesh.new()
    bottom = [bm.verts.new(p) for p in hexagon(cx, cz, r, z0)]
    top = [bm.verts.new(p) for p in hexagon(cx, cz, r, z0 + h)]
    bm.faces.new(top)
    bm.faces.new(list(reversed(bottom)))
    for k in range(6):
        j = (k + 1) % 6
        bm.faces.new((bottom[k], bottom[j], top[j], top[k]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def serpentine() -> list[tuple]:
    """Chemin de la kill chain : relie les centres, avec des demi-tours arrondis au bout des lignes."""
    pts = []
    z = GROUND_TOP + 0.012
    for i in range(TACTICS):
        x, zz = pad_center(i)
        pts.append(bl(x, zz, z))
        row, col = divmod(i, COLS)
        if col == COLS - 1 and row < ROWS - 1:  # demi-tour vers la ligne suivante
            side = 1 if row % 2 == 0 else -1
            nx, nz = pad_center(i + 1)
            for k in range(1, 8):
                a = -math.pi / 2 + math.pi * k / 8
                pts.append(bl(x + side * (PAD_R + 0.25) * math.cos(a) * 0.9, (zz + nz) / 2 + (DZ / 2) * math.sin(a), z))
    return pts


def build(mats):
    parts = []
    width, depth = COLS * DX + 0.9, ROWS * DZ + 0.9
    plate = dtx3d.object_from_bmesh("Hive_Plate", dtx3d.box_bmesh((width, depth, PLATE_H), (0.0, 0.0, PLATE_H / 2)), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.05, 3)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(dtx3d.object_from_bmesh("Hive_Ground", dtx3d.box_bmesh((width - 0.3, depth - 0.3, 0.01), (0.0, 0.0, PLATE_H + 0.005)), [mats["ground"]]))
    half_w, half_d = (width - 0.3) / 2, (depth - 0.3) / 2
    rim = [bl(-half_w, -half_d, GROUND_TOP + 0.01), bl(half_w, -half_d, GROUND_TOP + 0.01), bl(half_w, half_d, GROUND_TOP + 0.01), bl(-half_w, half_d, GROUND_TOP + 0.01)]
    parts.append(tube("Hive_Rim", rim, 0.012, mats["rim"], cyclic=True))
    parts.append(tube("Hive_Path", serpentine(), 0.03, mats["path"]))

    for i in range(TACTICS):
        x, z = pad_center(i)
        pad = dtx3d.object_from_bmesh(f"Pad_{i:02d}", hex_prism(x, z, PAD_R, GROUND_TOP, PAD_H), [mats["pad"]])
        rim_pad = tube(f"PadRim_{i:02d}", hexagon(x, z, PAD_R, GROUND_TOP + PAD_H + 0.004), 0.014, mats["pad_rim"], cyclic=True)
        pad["tactic_index"] = i
        rim_pad["tactic_index"] = i
        parts += [pad, rim_pad]
    return parts


def main():
    scene = dtx3d.reset_scene()
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_HiveGround", "#060d0c", roughness=0.85)
    mats["pad"] = dtx3d.make_material("MAT_Pad", "#0c1f1b", roughness=0.6, emission=dtx3d.ACCENT, strength=0.0)
    mats["pad_rim"] = dtx3d.make_material("MAT_PadRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.2)
    mats["path"] = dtx3d.make_material("MAT_HivePath", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.8)
    mats["rim"] = dtx3d.make_material("MAT_HiveRim", "#000000", roughness=0.4, emission="#8a97a9", strength=0.5)
    parts = build(mats)
    dtx3d.root_empty("Hive_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -15.5, 11.5), target=(0.0, 0.0, 0.0), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=3.2)
    dtx3d.finish("hive", __file__, scene, parts, preview_res=(1400, 820), poster_res=(1000, 590))


if __name__ == "__main__":
    main()
