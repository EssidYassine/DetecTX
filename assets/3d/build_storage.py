"""
build_storage.py - Reservoir de stockage 3D (page Systeme de DeTecTX).

Un reservoir : socle a anneau neon, colonne de verre, capot. Le web le duplique pour
chaque disque et le remplit d'un liquide lumineux au niveau d'occupation.

Usage : blender --background --python assets/3d/build_storage.py

Contrat avec le composant web (frontend/src/components/three/storage-tanks.tsx) :
    Tank_Widget (racine), MAT_TankRing (teinte selon le seuil d'occupation).
    GLASS_BOTTOM / GLASS_H / LIQUID_R ci-dessous : repris tels quels par le composant.
"""

import os
import sys

import bmesh

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

BASE_R, BASE_H = 0.42, 0.12
GLASS_R, GLASS_H = 0.36, 1.3
GLASS_BOTTOM = BASE_H
LIQUID_R = 0.33  # rayon du liquide (web), juste sous le verre


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ring"] = dtx3d.make_material("MAT_TankRing", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.2)
    mats["glass"] = dtx3d.make_material("MAT_Glass", "#9fd9d0", roughness=0.05, alpha=0.14)
    return mats


def build(mats):
    base_bm = dtx3d.cylinder_bmesh(BASE_R, BASE_H, (0.0, 0.0, BASE_H / 2), segments=48)
    top = dtx3d.top_face(base_bm)
    bmesh.ops.inset_region(base_bm, faces=[top], thickness=0.03, depth=0.0, use_even_offset=True)
    ring = bmesh.ops.inset_region(base_bm, faces=[top], thickness=0.02, depth=0.0, use_even_offset=True)["faces"]
    for f in ring:
        f.material_index = 1
    base = dtx3d.object_from_bmesh("Tank_Base", base_bm, [mats["metal"], mats["ring"]])
    dtx3d.add_bevel(base, 0.012)
    dtx3d.smooth_by_angle(base)

    glass = dtx3d.object_from_bmesh(
        "Tank_Glass", dtx3d.cylinder_bmesh(GLASS_R, GLASS_H, (0.0, 0.0, GLASS_BOTTOM + GLASS_H / 2), segments=48), [mats["glass"]]
    )
    dtx3d.smooth_by_angle(glass)

    cap = dtx3d.object_from_bmesh(
        "Tank_Cap", dtx3d.cylinder_bmesh(BASE_R - 0.02, 0.08, (0.0, 0.0, GLASS_BOTTOM + GLASS_H + 0.04), segments=48), [mats["metal"]]
    )
    dtx3d.add_bevel(cap, 0.012)
    dtx3d.smooth_by_angle(cap)
    return [base, glass, cap]


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Tank_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -3.4, 1.9), target=(0.0, 0.0, 0.75), lens=45)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.7), scale=1.0)
    dtx3d.finish("storage", __file__, scene, parts, preview_res=(600, 900), poster_res=(400, 600))


if __name__ == "__main__":
    main()
