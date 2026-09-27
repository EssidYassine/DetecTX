"""
build_city.py - Plateforme de la « ville des processus » (page Systeme de DeTecTX).

Un sol sombre quadrille, borde de neon. Le web y dresse un batiment par processus
(emprise = memoire, hauteur = CPU) selon un treemap calcule a chaque rafraichissement.

Usage : blender --background --python assets/3d/build_city.py

Contrat avec le composant web (frontend/src/components/three/process-city.tsx) :
    City_Widget (racine), MAT_CityEdge (bordure neon).
    GROUND_W / GROUND_D / GROUND_TOP ci-dessous : repris tels quels par le composant.
"""

import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

GROUND_W, GROUND_D = 6.0, 3.8
PLATE_H = 0.12
GROUND_TOP = PLATE_H + 0.01  # 0.13 : base des batiments


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_Ground", "#07120f", roughness=0.85)
    mats["edge"] = dtx3d.make_material("MAT_CityEdge", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.8)
    mats["grid"] = dtx3d.make_material("MAT_Grid", "#000000", roughness=0.4, emission="#8a97a9", strength=0.18)
    return mats


def build(mats):
    plate = dtx3d.object_from_bmesh("City_Plate", dtx3d.box_bmesh((GROUND_W + 0.4, GROUND_D + 0.4, PLATE_H), (0.0, 0.0, PLATE_H / 2)), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    ground = dtx3d.object_from_bmesh("City_Ground", dtx3d.box_bmesh((GROUND_W, GROUND_D, 0.01), (0.0, 0.0, PLATE_H + 0.005)), [mats["ground"]])

    # Bordure neon (4 cotes) en un seul maillage.
    bm = bmesh.new()
    t = 0.03
    for dims, center in (
        ((GROUND_W + t, t, 0.012), (0.0, -GROUND_D / 2, GROUND_TOP)),
        ((GROUND_W + t, t, 0.012), (0.0, GROUND_D / 2, GROUND_TOP)),
        ((t, GROUND_D + t, 0.012), (-GROUND_W / 2, 0.0, GROUND_TOP)),
        ((t, GROUND_D + t, 0.012), (GROUND_W / 2, 0.0, GROUND_TOP)),
    ):
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(Vector(center)) @ Matrix.Diagonal((*dims, 1.0)))
    edge = dtx3d.object_from_bmesh("City_Edge", bm, [mats["edge"]])

    # Quadrillage discret tous les 0.5 (lecture d'echelle), un seul maillage.
    bm = bmesh.new()
    x = -GROUND_W / 2 + 0.5
    while x < GROUND_W / 2 - 0.01:
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(Vector((x, 0.0, GROUND_TOP))) @ Matrix.Diagonal((0.008, GROUND_D, 0.004, 1.0)))
        x += 0.5
    y = -GROUND_D / 2 + 0.5
    while y < GROUND_D / 2 - 0.01:
        bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(Vector((0.0, y, GROUND_TOP))) @ Matrix.Diagonal((GROUND_W, 0.008, 0.004, 1.0)))
        y += 0.5
    grid = dtx3d.object_from_bmesh("City_Grid", bm, [mats["grid"]])
    return [plate, ground, edge, grid]


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("City_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -6.4, 4.8), target=(0.0, 0.0, 0.2), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=1.8)
    dtx3d.finish("city", __file__, scene, parts, preview_res=(1400, 800), poster_res=(1000, 570))


if __name__ == "__main__":
    main()
