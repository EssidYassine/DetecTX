"""
build_lineage.py - Scene de la « lignee » des processus (page Systeme, vue Processus).

Un plateau allonge a cinq couloirs, lus de gauche a droite comme une filiation :
grand-parent -> parent -> APPLICATION (couloir central, accentue) -> enfants -> descendants.
Des chevrons neon entre les couloirs indiquent le sens du lancement. Le web y pose un noeud
par processus et trace les liens parent -> enfant.

Usage : blender --background --python assets/3d/build_lineage.py

Contrat avec le composant web (frontend/src/components/three/lineage-graph.tsx) :
    Lineage_Widget (racine), Lineage_Lane_0..4 (userData.lane_index), MAT_LaneFocus.
    LANES_X / LANE_W / LANE_D / TOP_Z ci-dessous : repris tels quels par le composant.
"""

import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

LANES_X = (-3.0, -1.5, 0.0, 1.5, 3.0)
LANE_W, LANE_D = 1.3, 3.3
PLATE_W, PLATE_D, PLATE_H = 8.0, 3.9, 0.12
TOP_Z = PLATE_H + 0.012  # dessus des couloirs : base des noeuds


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_LinGround", "#07120f", roughness=0.85)
    mats["lane"] = dtx3d.make_material("MAT_Lane", "#0c1a17", roughness=0.7)
    mats["focus"] = dtx3d.make_material("MAT_LaneFocus", "#0f2420", roughness=0.6, emission=dtx3d.ACCENT, strength=0.25)
    mats["edge"] = dtx3d.make_material("MAT_LinEdge", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.6)
    mats["chevron"] = dtx3d.make_material("MAT_Chevron", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=1.4)
    return mats


def _box(bm, dims, center):
    bmesh.ops.create_cube(bm, size=1.0, matrix=Matrix.Translation(Vector(center)) @ Matrix.Diagonal((*dims, 1.0)))


def build(mats):
    parts = []
    plate = dtx3d.object_from_bmesh("Lineage_Plate", dtx3d.box_bmesh((PLATE_W, PLATE_D, PLATE_H), (0.0, 0.0, PLATE_H / 2)), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.025)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(
        dtx3d.object_from_bmesh(
            "Lineage_Ground", dtx3d.box_bmesh((PLATE_W - 0.3, PLATE_D - 0.3, 0.01), (0.0, 0.0, PLATE_H + 0.005)), [mats["ground"]]
        )
    )

    # Cinq couloirs ; le central (l'application) est accentue.
    for i, x in enumerate(LANES_X):
        lane = dtx3d.object_from_bmesh(
            f"Lineage_Lane_{i}",
            dtx3d.box_bmesh((LANE_W, LANE_D, 0.012), (x, 0.0, PLATE_H + 0.006)),
            [mats["focus"] if i == 2 else mats["lane"]],
        )
        lane["lane_index"] = i  # glTF extras -> userData.lane_index
        parts.append(lane)

    # Liseres neon du couloir central + bordure du plateau (un seul maillage).
    bm = bmesh.new()
    t, h = 0.025, 0.014
    for side in (-1, 1):
        _box(bm, (t, LANE_D, h), (side * LANE_W / 2, 0.0, TOP_Z))
    w, d = PLATE_W - 0.3, PLATE_D - 0.3
    _box(bm, (w, t, h), (0.0, -d / 2, TOP_Z))
    _box(bm, (w, t, h), (0.0, d / 2, TOP_Z))
    _box(bm, (t, d, h), (-w / 2, 0.0, TOP_Z))
    _box(bm, (t, d, h), (w / 2, 0.0, TOP_Z))
    parts.append(dtx3d.object_from_bmesh("Lineage_Edge", bm, [mats["edge"]]))

    # Chevrons « > » entre les couloirs, a l'avant : sens parent -> enfant.
    bm = bmesh.new()
    for a, b in zip(LANES_X, LANES_X[1:]):
        cx, cy = (a + b) / 2, -LANE_D / 2 + 0.25
        verts = [
            bm.verts.new((cx - 0.07, cy - 0.12, TOP_Z)),
            bm.verts.new((cx + 0.08, cy, TOP_Z)),
            bm.verts.new((cx - 0.07, cy + 0.12, TOP_Z)),
            bm.verts.new((cx - 0.02, cy, TOP_Z)),
        ]
        bm.faces.new(verts)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces[:])
    parts.append(dtx3d.object_from_bmesh("Lineage_Chevrons", bm, [mats["chevron"]]))
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Lineage_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -8.6, 6.0), target=(0.0, 0.0, 0.0), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.1), scale=1.9)
    dtx3d.finish("lineage", __file__, scene, parts, preview_res=(1400, 700), poster_res=(1000, 500))


if __name__ == "__main__":
    main()
