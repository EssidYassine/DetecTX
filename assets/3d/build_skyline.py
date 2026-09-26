"""
build_skyline.py - Skyline MITRE ATT&CK 3D de l'Overview DeTecTX.

Une plaque a 15 couloirs : les 14 tactiques ATT&CK dans l'ordre de la kill chain,
puis "Non classe". Le web y dresse une tour par technique detectee (hauteur = nombre
d'alertes). Les couloirs vides restent sombres : ils montrent les angles morts.

Usage : blender --background --python assets/3d/build_skyline.py

Contrat avec le composant web (frontend/src/components/three/attack-skyline.tsx) :
    Skyline_Widget (racine), Lane_00..14 et LaneMark_00..14 (userData.lane_index),
    MAT_LaneMark (repere avant, teinte selon l'activite du couloir).
    LANES / LANE_W / LANE_GAP / LANE_TOP_Z ci-dessous : repris tels quels par le composant.
"""

import os
import sys

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

LANES = 15
LANE_W, LANE_GAP = 0.5, 0.07
LANE_DEPTH = 1.8
PLATE_H = 0.12
LANE_TOP_Z = PLATE_H + 0.012  # 0.132 : sommet des couloirs, base des tours
SPAN = LANES * LANE_W + (LANES - 1) * LANE_GAP  # 8.48


def lane_x(i: int) -> float:
    return -SPAN / 2 + LANE_W / 2 + i * (LANE_W + LANE_GAP)


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    # Mat : un plancher brillant reflete les contre-jours en grands degrades qui noient les tours.
    mats["lane"] = dtx3d.make_material("MAT_LaneFloor", "#0a1a17", roughness=0.7)
    mats["mark"] = dtx3d.make_material("MAT_LaneMark", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.0)
    return mats


def build_plate(mats):
    ob = dtx3d.object_from_bmesh("Skyline_Plate", dtx3d.box_bmesh((SPAN + 0.42, LANE_DEPTH + 0.3, PLATE_H), (0.0, 0.0, PLATE_H / 2)), [mats["metal"]])
    dtx3d.add_bevel(ob, 0.02)
    dtx3d.smooth_by_angle(ob)
    return ob


def build_lanes(mats):
    """Un couloir (plancher) + un repere lumineux avant par tactique, indexes pour le web."""
    parts = []
    for i in range(LANES):
        x = lane_x(i)
        lane = dtx3d.object_from_bmesh(
            f"Lane_{i:02d}", dtx3d.box_bmesh((LANE_W, LANE_DEPTH, 0.012), (x, 0.0, PLATE_H + 0.006)), [mats["lane"]]
        )
        mark = dtx3d.object_from_bmesh(
            f"LaneMark_{i:02d}",
            dtx3d.box_bmesh((LANE_W - 0.06, 0.035, 0.012), (x, -LANE_DEPTH / 2 - 0.06, PLATE_H + 0.006)),
            [mats["mark"]],
        )
        lane["lane_index"] = i  # glTF extras -> userData.lane_index
        mark["lane_index"] = i
        parts += [lane, mark]
    return parts


def main():
    scene = dtx3d.reset_scene()
    mats = build_materials()
    parts = [build_plate(mats)] + build_lanes(mats)
    dtx3d.root_empty("Skyline_Widget", parts)

    # Focale courte : a ~9.9 m, 34 mm couvrent ~10 m de large, la plaque (8.9 m) entre entiere.
    dtx3d.camera_persp(scene, location=(0.0, -7.6, 6.4), target=(0.0, 0.2, 0.2), lens=34)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=2.2)
    # Rendus au format du widget (tres large), pas en carre.
    dtx3d.finish("skyline", __file__, scene, parts, preview_res=(1400, 640), poster_res=(1000, 460))


if __name__ == "__main__":
    main()
