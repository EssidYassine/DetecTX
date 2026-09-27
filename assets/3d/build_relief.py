"""
build_relief.py - Socle du « relief de l'activite » (page Evenements de DeTecTX).

Un plateau long : un couloir par journal Windows (Securite, Systeme, Applications,
PowerShell, Sysmon, fichiers), le temps s'ecoulant de gauche a droite. Le web y eleve un
relief par couloir (nombre d'evenements par heure) et plante des balises lumineuses la ou le
moteur a leve des alertes. Graduations regulieres le long du bord avant, repere « maintenant »
a droite.

Usage : blender --background --python assets/3d/build_relief.py

Contrat avec le composant web (frontend/src/components/three/event-relief.tsx) :
    Relief_Widget (racine), Relief_Lane_0..5 (userData.lane_index), MAT_ReliefNow.
    TERRAIN_W / LANES / LANE_D / LANE_GAP / TOP_Z / TICKS ci-dessous : repris par le composant.
"""

import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

TERRAIN_W = 7.6
LANES = 6
LANE_D, LANE_GAP = 0.62, 0.08
SPAN_D = LANES * LANE_D + (LANES - 1) * LANE_GAP  # 4.12
PLATE_W, PLATE_D, PLATE_H = TERRAIN_W + 0.8, SPAN_D + 0.9, 0.12
TOP_Z = PLATE_H + 0.012
TICKS = 8  # graduations : TICKS intervalles egaux sur la largeur du terrain


def lane_y(i: int) -> float:
    """Couloir 0 a l'avant (vers la camera, -Y en Blender)."""
    return -SPAN_D / 2 + LANE_D / 2 + i * (LANE_D + LANE_GAP)


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_ReliefGround", "#07120f", roughness=0.85)
    mats["lane"] = dtx3d.make_material("MAT_ReliefLane", "#0b1714", roughness=0.75)
    mats["edge"] = dtx3d.make_material("MAT_ReliefEdge", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.5)
    mats["tick"] = dtx3d.make_material("MAT_ReliefTick", "#000000", roughness=0.4, emission="#8a97a9", strength=0.6)
    mats["now"] = dtx3d.make_material("MAT_ReliefNow", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=2.4)
    return mats


def _box(bm, dims, center):
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(Vector(center)) @ Matrix.Diagonal((*dims, 1.0)))


def build(mats):
    parts = []
    plate = dtx3d.object_from_bmesh("Relief_Plate", dtx3d.box_bmesh((PLATE_W, PLATE_D, PLATE_H), (0.0, 0.0, PLATE_H / 2)), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.025)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(
        dtx3d.object_from_bmesh("Relief_Ground", dtx3d.box_bmesh((PLATE_W - 0.3, PLATE_D - 0.3, 0.01), (0.0, 0.0, PLATE_H + 0.005)), [mats["ground"]])
    )

    for i in range(LANES):
        lane = dtx3d.object_from_bmesh(
            f"Relief_Lane_{i}", dtx3d.box_bmesh((TERRAIN_W, LANE_D, 0.012), (0.0, lane_y(i), PLATE_H + 0.006)), [mats["lane"]]
        )
        lane["lane_index"] = i  # glTF extras -> userData.lane_index
        parts.append(lane)

    # Bordure neon du plateau.
    bm = bmesh.new()
    t, h = 0.025, 0.014
    w, d = PLATE_W - 0.3, PLATE_D - 0.3
    _box(bm, (w, t, h), (0.0, -d / 2, TOP_Z))
    _box(bm, (w, t, h), (0.0, d / 2, TOP_Z))
    _box(bm, (t, d, h), (-w / 2, 0.0, TOP_Z))
    _box(bm, (t, d, h), (w / 2, 0.0, TOP_Z))
    parts.append(dtx3d.object_from_bmesh("Relief_Edge", bm, [mats["edge"]]))

    # Graduations du temps le long du bord avant (le web y pose les heures).
    bm = bmesh.new()
    front = -SPAN_D / 2 - 0.16
    for k in range(TICKS + 1):
        x = -TERRAIN_W / 2 + k * TERRAIN_W / TICKS
        _box(bm, (0.012, 0.14 if k % 2 == 0 else 0.08, 0.006), (x, front, TOP_Z))
    parts.append(dtx3d.object_from_bmesh("Relief_Ticks", bm, [mats["tick"]]))

    # Repere « maintenant » : liseré vertical au bout du temps.
    parts.append(
        dtx3d.object_from_bmesh("Relief_Now", dtx3d.box_bmesh((0.02, SPAN_D + 0.1, 0.02), (TERRAIN_W / 2 + 0.05, 0.0, TOP_Z)), [mats["now"]])
    )
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Relief_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -8.8, 6.2), target=(0.0, 0.0, 0.0), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.1), scale=2.0)
    dtx3d.finish("relief", __file__, scene, parts, preview_res=(1400, 700), poster_res=(1000, 500))


if __name__ == "__main__":
    main()
