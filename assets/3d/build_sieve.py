"""
build_sieve.py - « Le Tamis de renseignement » de la page Threat Intel DeTecTX.

Une colonne de 4 disques de verre superposes (un par source de renseignement), un entonnoir
d'entree en haut, une vasque en bas (« rien de connu ») et un mat central. Le web y fait tomber
les indicateurs du poste : un grain s'arrete et s'allume sur le disque de la source qui le
reconnait ; les autres finissent dans la vasque.

Usage : blender --background --python assets/3d/build_sieve.py

Contrat avec le composant web (frontend/src/components/three/sieve.tsx) :
    Sieve_Widget (racine), Layer_00..03 (MAT_Layer) et LayerRim_00..03 (MAT_LayerRim,
    userData.layer_index), Sieve_Basin (MAT_Basin), Sieve_Funnel (MAT_Funnel).
    Constantes : LAYER_Y (hauteur de chaque disque), LAYER_R, BASIN_Y, BASIN_R, TOP_Y.
"""

import math
import os
import sys

import bmesh

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

LAYERS = 4
LAYER_Y = (2.55, 1.95, 1.35, 0.75)  # de haut en bas : listes locales, AbuseIPDB, VirusTotal, MISP/OTX
LAYER_R = 1.55
LAYER_H = 0.035
BASIN_Y = 0.12
BASIN_R = 1.75
TOP_Y = 3.25


def open_cone(r_top: float, r_bottom: float, z_top: float, z_bottom: float, segments: int = 96) -> bmesh.types.BMesh:
    bm = dtx3d.cylinder_bmesh(1.0, 1.0, (0.0, 0.0, 0.0), segments=segments)
    for v in bm.verts:
        top = v.co.z > 0
        r = r_top if top else r_bottom
        a = math.atan2(v.co.y, v.co.x)
        v.co.x, v.co.y, v.co.z = r * math.cos(a), r * math.sin(a), z_top if top else z_bottom
    caps = [f for f in bm.faces if abs(f.normal.z) > 0.9]
    bmesh.ops.delete(bm, geom=caps, context="FACES_ONLY")
    bm.normal_update()
    return bm


def build(mats):
    parts = []
    base = dtx3d.object_from_bmesh("Sieve_Base", dtx3d.cylinder_bmesh(BASIN_R + 0.35, 0.1, (0.0, 0.0, 0.05), segments=96), [mats["metal"]])
    dtx3d.add_bevel(base, 0.02)
    dtx3d.smooth_by_angle(base)
    parts.append(base)
    # Vasque : fond + paroi basse (les indicateurs que rien ne connait).
    parts.append(dtx3d.object_from_bmesh("Sieve_Basin", dtx3d.cylinder_bmesh(BASIN_R, 0.02, (0.0, 0.0, BASIN_Y - 0.01), segments=96), [mats["basin"]]))
    parts.append(dtx3d.object_from_bmesh("Sieve_BasinWall", open_cone(BASIN_R + 0.05, BASIN_R, BASIN_Y + 0.28, BASIN_Y), [mats["glass"]]))
    parts.append(dtx3d.object_from_bmesh("Sieve_BasinRim", dtx3d.torus_bmesh(BASIN_R + 0.05, 0.014, (0.0, 0.0, BASIN_Y + 0.28), 128, 6), [mats["rim"]]))
    # Mat central.
    mast = dtx3d.object_from_bmesh("Sieve_Mast", dtx3d.cylinder_bmesh(0.05, TOP_Y - BASIN_Y, (0.0, 0.0, (TOP_Y + BASIN_Y) / 2), segments=16), [mats["metal_light"]])
    parts.append(mast)
    # Disques (tamis) avec liseré, un par source.
    for i, y in enumerate(LAYER_Y):
        disc = dtx3d.object_from_bmesh(f"Layer_{i:02d}", dtx3d.cylinder_bmesh(LAYER_R, LAYER_H, (0.0, 0.0, y), segments=96), [mats["layer"]])
        rim = dtx3d.object_from_bmesh(f"LayerRim_{i:02d}", dtx3d.torus_bmesh(LAYER_R, 0.018, (0.0, 0.0, y + LAYER_H / 2), 128, 6), [mats["layer_rim"]])
        disc["layer_index"] = i
        rim["layer_index"] = i
        parts += [disc, rim]
    # Entonnoir d'entree : les indicateurs du poste arrivent par le haut.
    parts.append(dtx3d.object_from_bmesh("Sieve_Funnel", open_cone(0.95, 0.22, TOP_Y + 0.35, TOP_Y - 0.1), [mats["funnel"]]))
    parts.append(dtx3d.object_from_bmesh("Sieve_FunnelRim", dtx3d.torus_bmesh(0.95, 0.014, (0.0, 0.0, TOP_Y + 0.35), 96, 6), [mats["rim"]]))
    return parts


def main():
    scene = dtx3d.reset_scene()
    mats = dtx3d.base_materials()
    mats["glass"] = dtx3d.make_material("MAT_SieveGlass", "#2dd4bf", roughness=0.08, emission=dtx3d.ACCENT, strength=0.15, alpha=0.12)
    mats["layer"] = dtx3d.make_material("MAT_Layer", "#2dd4bf", roughness=0.08, emission=dtx3d.ACCENT, strength=0.2, alpha=0.16)
    mats["layer_rim"] = dtx3d.make_material("MAT_LayerRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.2)
    mats["basin"] = dtx3d.make_material("MAT_Basin", "#0b1d1a", roughness=0.6, emission=dtx3d.ACCENT, strength=0.05)
    mats["funnel"] = dtx3d.make_material("MAT_Funnel", "#fbbf77", roughness=0.1, emission="#fbbf77", strength=0.35, alpha=0.2)
    mats["rim"] = dtx3d.make_material("MAT_SieveRim", "#000000", roughness=0.4, emission="#8a97a9", strength=0.8)
    parts = build(mats)
    dtx3d.root_empty("Sieve_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -8.6, 4.6), target=(0.0, 0.0, 1.6), lens=40)
    dtx3d.studio(scene, target=(0.0, 0.0, 1.5), scale=1.6)
    dtx3d.finish("sieve", __file__, scene, parts, preview_res=(1200, 900), poster_res=(900, 675))


if __name__ == "__main__":
    main()
