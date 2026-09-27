"""
build_timeline.py - Chronologie 3D des alertes (page Alertes de DeTecTX).

Une plaque de 30 jours (axe X, du plus ancien a gauche a aujourd'hui a droite) sur
4 rangees de severite (axe Y : critique a l'avant, puis haute, moyenne, faible).
Le web y dresse une tour par (jour, severite) ; survol/clic = filtre du tableau.

Usage : blender --background --python assets/3d/build_timeline.py

Contrat avec le composant web (frontend/src/components/three/alert-timeline.tsx) :
    Timeline_Widget (racine), Timeline_Grid (dalles jour x severite, un seul maillage),
    Lane_<severite> (MAT_Lane_<severite>, repere colore a gauche), Today_Mark.
    Le survol par jour est gere cote web (zones invisibles), pas par le modele.
    DAYS / SLOT_W / SLOT_GAP / LANE_D / LANE_GAP / TOP_Z : repris tels quels par le composant.
"""

import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

DAYS = 30
SLOT_W, SLOT_GAP = 0.3, 0.04
LANE_D, LANE_GAP = 0.42, 0.06
SEVERITIES = ["critical", "high", "medium", "low"]  # de l'avant (camera) vers l'arriere
SEVERITY_HEX = {"critical": "#f43f5e", "high": "#fbbf24", "medium": dtx3d.ACCENT, "low": "#8a97a9"}
PLATE_H = 0.1
TOP_Z = PLATE_H + 0.008  # sommet des bandes : base des tours

SPAN_X = DAYS * SLOT_W + (DAYS - 1) * SLOT_GAP  # 10.16
SPAN_Y = len(SEVERITIES) * LANE_D + (len(SEVERITIES) - 1) * LANE_GAP  # 1.86


def day_x(i: int) -> float:
    return -SPAN_X / 2 + SLOT_W / 2 + i * (SLOT_W + SLOT_GAP)


def lane_y(j: int) -> float:
    # j = 0 (critique) a l'avant, c.-a-d. vers -Y (cote camera).
    return -SPAN_Y / 2 + LANE_D / 2 + j * (LANE_D + LANE_GAP)


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["tile"] = dtx3d.make_material("MAT_Tile", "#0a1a17", roughness=0.85)
    mats["today"] = dtx3d.make_material("MAT_Today", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=2.0)
    for sev, hex_ in SEVERITY_HEX.items():
        mats[f"lane_{sev}"] = dtx3d.make_material(f"MAT_Lane_{sev}", "#000000", roughness=0.4, emission=hex_, strength=1.4)
    return mats


def build(mats):
    parts = []
    plate = dtx3d.object_from_bmesh(
        "Timeline_Plate",
        dtx3d.box_bmesh((SPAN_X + 0.9, SPAN_Y + 0.4, PLATE_H), (0.2, 0.0, PLATE_H / 2)),
        [mats["metal"]],
    )
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)

    # Grille de dalles (jour x severite) fusionnee en UN maillage : un seul appel de rendu
    # au lieu de 120, et les 4 rangees de severite restent lisibles.
    bm = bmesh.new()
    for i in range(DAYS):
        for j in range(len(SEVERITIES)):
            m = Matrix.Translation(Vector((day_x(i), lane_y(j), PLATE_H + 0.004))) @ Matrix.Diagonal((SLOT_W, LANE_D, 0.008, 1.0))
            bmesh.ops.create_cube(bm, size=1.0, matrix=m)
    parts.append(dtx3d.object_from_bmesh("Timeline_Grid", bm, [mats["tile"]]))

    # Repere colore de chaque rangee de severite, a gauche de la plaque.
    for j, sev in enumerate(SEVERITIES):
        mark = dtx3d.object_from_bmesh(
            f"Lane_{sev}",
            dtx3d.box_bmesh((0.1, LANE_D - 0.06, 0.012), (-SPAN_X / 2 - 0.22, lane_y(j), PLATE_H + 0.006)),
            [mats[f"lane_{sev}"]],
        )
        mark["severity"] = sev
        parts.append(mark)

    # Aujourd'hui : liseré lumineux devant la derniere journee.
    parts.append(
        dtx3d.object_from_bmesh(
            "Today_Mark",
            dtx3d.box_bmesh((SLOT_W, 0.04, 0.012), (day_x(DAYS - 1), -SPAN_Y / 2 - 0.1, PLATE_H + 0.006)),
            [mats["today"]],
        )
    )
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Timeline_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -7.2, 5.4), target=(0.0, 0.1, 0.2), lens=22)  # focale courte : plaque de 11 m entiere
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=2.4)
    dtx3d.finish("timeline", __file__, scene, parts, preview_res=(1600, 520), poster_res=(1200, 390))


if __name__ == "__main__":
    main()
