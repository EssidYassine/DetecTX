"""
build_roots.py - « Les Racines » : ce qui se relance au demarrage (page Systeme, vue Persistance).

En surface, le socle du poste. Dessous, un sol en coupe a trois strates (utilisateur, machine,
noyau) ou plongent six racines, une par mecanisme de persistance : cles Run, dossier Demarrage,
taches planifiees, services, pilotes, abonnements WMI. Le web pose chaque entree comme un
nodule le long de SA racine, a la profondeur de ses privileges ; les nouvelles pulsent.

Usage : blender --background --python assets/3d/build_roots.py

Contrat avec le composant web (frontend/src/components/three/roots.tsx) :
    Roots_Widget (racine), Root_00..05 (MAT_Root, userData.root_index), RootTip_00..05
    (MAT_RootTip), Soil_Strata_00..02 (MAT_Strata_00..02), Machine_Plinth, MAT_PlinthGlow.
    ROOTS (points de controle Bezier, repere Blender Z-haut) et STRATA_Z : repris par le
    composant (conversion glTF : (x, y, z) Blender -> (x, z, -y)).
"""

import math
import os
import sys

import bpy

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

DEPTH = 3.3  # profondeur du sol ; z(t) = -DEPTH * t (points de controle equidistants en z)
STRATA_Z = (0.0, -1.1, -2.2, -3.3)  # limites : utilisateur | machine & systeme | noyau
SOIL_W, SOIL_D = 6.6, 1.5
# Racine i : (depart sous le socle) -> (pointe), Bezier cubique aux controles equidistants en z.
TOPS = (-0.75, -0.45, -0.15, 0.15, 0.45, 0.75)
TIPS = ((-2.85, 0.25), (-1.75, -0.2), (-0.62, 0.3), (0.62, -0.25), (1.75, 0.2), (2.85, -0.15))


def root_controls(i: int) -> tuple:
    """Quatre points de controle (x, y, z) de la racine i."""
    sx = TOPS[i]
    tx, ty = TIPS[i]
    return (
        (sx, 0.0, 0.0),
        (sx * 1.05, 0.0, -DEPTH / 3),
        (tx * 0.9, ty * 0.6, -2 * DEPTH / 3),
        (tx, ty, -DEPTH),
    )


def bezier(p, t: float) -> tuple:
    u = 1 - t
    return tuple(u**3 * p[0][k] + 3 * u * u * t * p[1][k] + 3 * u * t * t * p[2][k] + t**3 * p[3][k] for k in range(3))


def tube(name, controls, r0, r1, material, resolution=24):
    """Racine effilee : courbe de Bezier a biseau, rayon decroissant, convertie en maillage."""
    curve = bpy.data.curves.new(name, "CURVE")
    curve.dimensions = "3D"
    curve.resolution_u = resolution
    curve.bevel_depth = 1.0
    curve.bevel_resolution = 3
    curve.use_fill_caps = True
    spline = curve.splines.new("BEZIER")
    spline.bezier_points.add(1)
    a, b = spline.bezier_points
    a.co, a.handle_right, a.radius = controls[0], controls[1], r0
    a.handle_left = tuple(2 * c0 - c1 for c0, c1 in zip(controls[0], controls[1]))
    b.co, b.handle_left, b.radius = controls[3], controls[2], r1
    b.handle_right = tuple(2 * c3 - c2 for c3, c2 in zip(controls[3], controls[2]))
    ob = bpy.data.objects.new(name, curve)
    dtx3d.link(ob)
    mesh = bpy.data.meshes.new_from_object(ob.evaluated_get(bpy.context.evaluated_depsgraph_get()))
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(curve)
    out = bpy.data.objects.new(name, mesh)
    dtx3d.link(out)
    mesh.materials.append(material)
    dtx3d.smooth_by_angle(out, 60)
    return out


def rootlets(i, material):
    """Radicelles decoratives : trois fines branches par racine (aspect organique)."""
    parts = []
    main = root_controls(i)
    for k, t in enumerate((0.3, 0.55, 0.78)):
        start = bezier(main, t)
        side = 1 if (i + k) % 2 else -1
        length = 0.55 - 0.1 * k
        end = (start[0] + side * length, start[1] + 0.15 * side, start[2] - 0.5)
        # Branche oblique, a peine courbee : plonge en s'ecartant, comme une vraie radicelle.
        ctrl = (start, tuple(a + (b - a) * 0.35 for a, b in zip(start, end)), tuple(a + (b - a) * 0.7 + (0, 0, -0.06)[j] for j, (a, b) in enumerate(zip(start, end))), end)
        parts.append(tube(f"Rootlet_{i:02d}_{k}", ctrl, 0.022, 0.004, material, resolution=12))
    return parts


def build(mats):
    parts = []
    # Socle du poste (surface) + liseré lumineux.
    plinth = dtx3d.object_from_bmesh("Machine_Plinth", dtx3d.box_bmesh((2.3, 1.05, 0.34), (0.0, 0.0, 0.2)), [mats["metal"]])
    dtx3d.add_bevel(plinth, 0.05, 3)
    parts.append(plinth)
    parts.append(dtx3d.object_from_bmesh("Machine_Screen", dtx3d.box_bmesh((1.7, 0.03, 0.035), (0.0, -0.53, 0.27)), [mats["plinth_glow"]]))
    parts.append(dtx3d.object_from_bmesh("Soil_Surface", dtx3d.box_bmesh((SOIL_W + 0.3, SOIL_D + 0.2, 0.03), (0.0, 0.0, 0.0)), [mats["surface"]]))
    # Strates translucides (de haut en bas : utilisateur, machine & systeme, noyau).
    for s in range(3):
        top, bottom = STRATA_Z[s], STRATA_Z[s + 1]
        slab = dtx3d.object_from_bmesh(f"Soil_Strata_{s:02d}", dtx3d.box_bmesh((SOIL_W, SOIL_D, top - bottom - 0.02), (0.0, 0.0, (top + bottom) / 2)), [mats[f"strata_{s}"]])
        slab["stratum_index"] = s
        parts.append(slab)
        if s:  # fine ligne de separation lumineuse a l'avant du sol
            parts.append(dtx3d.object_from_bmesh(f"Soil_Line_{s:02d}", dtx3d.box_bmesh((SOIL_W, 0.012, 0.012), (0.0, -SOIL_D / 2, top)), [mats["line"]]))
    # Racines + pointes.
    for i in range(6):
        controls = root_controls(i)
        root = tube(f"Root_{i:02d}", controls, 0.1, 0.02, mats["root"])
        root["root_index"] = i
        parts.append(root)
        parts += rootlets(i, mats["rootlet"])
        tip = dtx3d.object_from_bmesh(f"RootTip_{i:02d}", dtx3d.icosphere_bmesh(0.07, controls[3], 2), [mats["tip"]])
        tip["root_index"] = i
        parts.append(tip)
    return parts


def main():
    scene = dtx3d.reset_scene()
    mats = dtx3d.base_materials()
    mats["plinth_glow"] = dtx3d.make_material("MAT_PlinthGlow", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.4)
    mats["surface"] = dtx3d.make_material("MAT_SoilSurface", "#1a2a26", roughness=0.8, emission=dtx3d.ACCENT, strength=0.06, alpha=0.55)
    mats["strata_0"] = dtx3d.make_material("MAT_Strata_00", "#2dd4bf", roughness=0.3, emission=dtx3d.ACCENT, strength=0.05, alpha=0.07)
    mats["strata_1"] = dtx3d.make_material("MAT_Strata_01", "#fbbf77", roughness=0.3, emission="#fbbf77", strength=0.04, alpha=0.06)
    mats["strata_2"] = dtx3d.make_material("MAT_Strata_02", "#f87171", roughness=0.3, emission="#f87171", strength=0.04, alpha=0.07)
    mats["line"] = dtx3d.make_material("MAT_SoilLine", "#000000", roughness=0.4, emission="#8a97a9", strength=0.9)
    mats["root"] = dtx3d.make_material("MAT_Root", "#2a2118", metallic=0.3, roughness=0.55, emission="#fbbf77", strength=0.12)
    mats["rootlet"] = dtx3d.make_material("MAT_Rootlet", "#2a2118", metallic=0.2, roughness=0.6, emission="#fbbf77", strength=0.08)
    mats["tip"] = dtx3d.make_material("MAT_RootTip", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.0)
    parts = build(mats)
    dtx3d.root_empty("Roots_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -10.5, 1.2), target=(0.0, 0.0, -1.45), lens=40)
    dtx3d.studio(scene, target=(0.0, 0.0, -1.4), scale=1.8)
    dtx3d.finish("roots", __file__, scene, parts, preview_res=(1400, 900), poster_res=(1000, 640))


if __name__ == "__main__":
    main()
