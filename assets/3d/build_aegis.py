"""
build_aegis.py - « Bouclier vivant » de l'Overview DeTecTX (posture du poste).

Le poste sur son socle, un coeur de lumiere au-dessus, sous un dome de verre en 5 petales :
un par pilier de posture (Menaces face a la camera, puis Exposition, Defense, Visibilite,
Sante en tournant vers la gauche). Le web teinte chaque petale selon son etat, ouvre une
breche quand un pilier faiblit et fait respirer le coeur.

Usage : blender --background --python assets/3d/build_aegis.py

Contrat avec le composant web (frontend/src/components/three/aegis-shield.tsx) :
    Aegis_Widget (racine), Petal_00..04 (verre, MAT_Petal), PetalRim_00..04 (liseré,
    MAT_PetalRim), PetalBase_00..04 (arc au sol, MAT_PetalBase) : userData.pillar_index ;
    Aegis_Heart (coeur, MAT_AegisHeart). Constantes : GROUND_TOP, DOME_R, HEART_Y, START, STEP.

Reperes : angle phi dans le repere three.js (x = cos phi, z = sin phi, +Z vers la camera) ;
Blender -> three : (x, y, z) -> (x, z, -y).
"""

import math
import os
import sys

import bmesh
import bpy

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

PLATE_R, PLATE_H = 2.75, 0.1
GROUND_TOP = 0.11
DOME_R = 1.95
PILLARS = 5
STEP = 2 * math.pi / PILLARS
START = math.pi / 2  # petale 0 (Menaces) face a la camera
GAP = math.radians(3.2)  # demi-ecart entre petales
ELEV = (math.radians(3), math.radians(78))  # bas et haut des petales (couronne au-dessus)
HEART_Y = 1.02


def phi_of(i: int) -> float:
    return START + STEP * i


def dome_point(phi: float, elev: float, r: float = DOME_R) -> tuple:
    """Point du dome (repere three : azimut phi, elevation) -> coordonnees Blender."""
    x = r * math.cos(elev) * math.cos(phi)
    z3 = r * math.cos(elev) * math.sin(phi)
    return (x, -z3, GROUND_TOP + r * math.sin(elev))


def ground_point(phi: float, r: float, z: float) -> tuple:
    return (r * math.cos(phi), -r * math.sin(phi), z)


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_AegisGround", "#070d0c", roughness=0.85)
    mats["petal"] = dtx3d.make_material("MAT_Petal", "#2dd4bf", roughness=0.08, emission=dtx3d.ACCENT, strength=0.25, alpha=0.16)
    mats["rim"] = dtx3d.make_material("MAT_PetalRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.4)
    mats["base"] = dtx3d.make_material("MAT_PetalBase", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.2)
    mats["heart"] = dtx3d.make_material("MAT_AegisHeart", "#000000", roughness=0.2, emission="#fbbf77", strength=4.0)
    mats["crown"] = dtx3d.make_material("MAT_AegisCrown", "#000000", roughness=0.4, emission="#8a97a9", strength=0.6)
    mats["grid"] = dtx3d.make_material("MAT_AegisGrid", "#000000", roughness=0.4, emission="#8a97a9", strength=0.14)
    return mats


def tube(name: str, points: list[tuple], radius: float, material, cyclic: bool = False):
    """Tube lisse le long d'une polyligne (courbe biseautee convertie en maillage)."""
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


def petal_shell(i: int, material, az_seg: int = 14, el_seg: int = 12):
    a0, a1 = phi_of(i) - STEP / 2 + GAP, phi_of(i) + STEP / 2 - GAP
    bm = bmesh.new()
    grid = [
        [bm.verts.new(dome_point(a0 + (a1 - a0) * u / az_seg, ELEV[0] + (ELEV[1] - ELEV[0]) * v / el_seg)) for v in range(el_seg + 1)]
        for u in range(az_seg + 1)
    ]
    for u in range(az_seg):
        for v in range(el_seg):
            bm.faces.new((grid[u][v], grid[u + 1][v], grid[u + 1][v + 1], grid[u][v + 1]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return dtx3d.object_from_bmesh(f"Petal_{i:02d}", bm, [material])


def petal_border(i: int, segments: int = 14) -> list[tuple]:
    a0, a1 = phi_of(i) - STEP / 2 + GAP, phi_of(i) + STEP / 2 - GAP
    e0, e1 = ELEV
    pts = [dome_point(a0 + (a1 - a0) * k / segments, e0) for k in range(segments + 1)]
    pts += [dome_point(a1, e0 + (e1 - e0) * k / segments) for k in range(1, segments + 1)]
    pts += [dome_point(a1 - (a1 - a0) * k / segments, e1) for k in range(1, segments + 1)]
    pts += [dome_point(a0, e1 - (e1 - e0) * k / segments) for k in range(1, segments)]
    return pts


def build(mats):
    parts = []
    plate = dtx3d.object_from_bmesh("Aegis_Plate", dtx3d.cylinder_bmesh(PLATE_R, PLATE_H, (0.0, 0.0, PLATE_H / 2), segments=120), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(dtx3d.object_from_bmesh("Aegis_Ground", dtx3d.cylinder_bmesh(PLATE_R - 0.12, 0.01, (0.0, 0.0, PLATE_H + 0.005), segments=120), [mats["ground"]]))
    for k, r in enumerate((0.7, 1.35, DOME_R + 0.32, PLATE_R - 0.2)):
        parts.append(dtx3d.object_from_bmesh(f"Aegis_Ring_{k}", dtx3d.torus_bmesh(r, 0.005, (0.0, 0.0, GROUND_TOP + 0.01), 128, 4), [mats["grid"]]))

    for i in range(PILLARS):
        shell = petal_shell(i, mats["petal"])
        rim = tube(f"PetalRim_{i:02d}", petal_border(i), 0.012, mats["rim"], cyclic=True)
        a0, a1 = phi_of(i) - STEP / 2 + GAP, phi_of(i) + STEP / 2 - GAP
        arc = [ground_point(a0 + (a1 - a0) * k / 24, DOME_R + 0.2, GROUND_TOP + 0.02) for k in range(25)]
        base = tube(f"PetalBase_{i:02d}", arc, 0.028, mats["base"])
        for ob in (shell, rim, base):
            ob["pillar_index"] = i  # glTF extras -> userData.pillar_index
        parts += [shell, rim, base]

    # Couronne au sommet (les petales convergent sans se toucher).
    parts.append(dtx3d.object_from_bmesh("Aegis_Crown", dtx3d.torus_bmesh(DOME_R * math.cos(ELEV[1] + 0.05), 0.01, (0.0, 0.0, GROUND_TOP + DOME_R * math.sin(ELEV[1] + 0.05)), 64, 4), [mats["crown"]]))

    # Le poste et son coeur.
    base = dtx3d.object_from_bmesh("Aegis_HostBase", dtx3d.cylinder_bmesh(0.42, 0.1, (0.0, 0.0, GROUND_TOP + 0.05), segments=6), [mats["metal_light"]])
    dtx3d.add_bevel(base, 0.012)
    parts.append(base)
    host = dtx3d.object_from_bmesh("Aegis_Host", dtx3d.box_bmesh((0.26, 0.26, 0.52), (0.0, 0.0, GROUND_TOP + 0.1 + 0.26)), [mats["metal"]])
    dtx3d.add_bevel(host, 0.018)
    parts.append(host)
    parts.append(dtx3d.object_from_bmesh("Aegis_HostTop", dtx3d.box_bmesh((0.2, 0.2, 0.02), (0.0, 0.0, GROUND_TOP + 0.63)), [mats["heart"]]))
    heart = dtx3d.object_from_bmesh("Aegis_Heart", dtx3d.icosphere_bmesh(0.15, (0.0, 0.0, HEART_Y), subdivisions=3), [mats["heart"]])
    dtx3d.smooth_by_angle(heart, 60)
    parts.append(heart)
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Aegis_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -7.4, 3.9), target=(0.0, 0.0, 0.75), lens=38)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.6), scale=1.6)
    dtx3d.finish("aegis", __file__, scene, parts, preview_res=(1200, 900), poster_res=(900, 675))


if __name__ == "__main__":
    main()
