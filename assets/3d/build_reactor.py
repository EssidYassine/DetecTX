"""
build_reactor.py - Reacteur de menace 3D de l'Overview DeTecTX.

Un noyau-gemme dans une cage metallique, au-dessus d'un socle a anneau neon. Autour,
4 orbites (critique -> faible) sur lesquelles le web fait graviter chaque alerte reelle.

Usage : blender --background --python assets/3d/build_reactor.py

Contrat avec le composant web (frontend/src/components/three/threat-reactor.tsx) :
    Reactor_Widget (racine)
    Reactor_Core (MAT_ReactorCore)        -> teinte posture + pulsation si alertes critiques
    MAT_ReactorRing, MAT_ReactorBeam      -> teinte posture
    Reactor_Cage, Reactor_Gimbal_A/B      -> rotation continue
    Reactor_Shell_<severite> (userData.severity) -> teinte de la severite, eteint si vide
    ORBIT_RADII / CORE_Z ci-dessous       -> repris tels quels par le composant
"""

import math
import os
import sys

import bmesh
from mathutils import Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

CORE_Z = 1.0
# Orbites par severite (du plus proche au plus lointain) : critique au plus pres du noyau.
ORBIT_RADII = {"critical": 1.05, "high": 1.35, "medium": 1.65, "low": 1.95}
SEVERITY_HEX = {"critical": "#f43f5e", "high": "#fbbf24", "medium": dtx3d.ACCENT, "low": "#8a97a9"}

PEDESTAL_R, PEDESTAL_H = 1.15, 0.14


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ring"] = dtx3d.make_material("MAT_ReactorRing", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=3.0)
    mats["beam"] = dtx3d.make_material("MAT_ReactorBeam", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.5)
    # Emission moderee : les facettes de la gemme doivent rester lisibles (pas une tache plate).
    mats["core"] = dtx3d.make_material("MAT_ReactorCore", "#04201b", metallic=0.3, roughness=0.25, emission=dtx3d.ACCENT, strength=1.3)
    mats["gimbal"] = dtx3d.make_material("MAT_Gimbal", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=0.7)
    mats["floor"] = dtx3d.make_material("MAT_ReactorFloor", "#03100d", roughness=0.15)
    for sev, hex_ in SEVERITY_HEX.items():
        mats[f"shell_{sev}"] = dtx3d.make_material(f"MAT_Shell_{sev}", "#000000", roughness=0.4, emission=hex_, strength=0.8)
    return mats


def build_pedestal(mats):
    """Socle cylindrique : bordure metal, anneau neon, plateau central en retrait."""
    bm = dtx3d.cylinder_bmesh(PEDESTAL_R, PEDESTAL_H, (0.0, 0.0, PEDESTAL_H / 2), segments=64)
    top = dtx3d.top_face(bm)
    bmesh.ops.inset_region(bm, faces=[top], thickness=0.14, depth=0.0, use_even_offset=True)
    ring = bmesh.ops.inset_region(bm, faces=[top], thickness=0.03, depth=0.0, use_even_offset=True)["faces"]
    for f in ring:
        f.material_index = 1
    ret = bmesh.ops.extrude_face_region(bm, geom=[top])
    new_verts = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=Vector((0.0, 0.0, -0.02)), verts=new_verts)
    bmesh.ops.delete(bm, geom=[top], context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    for f in bm.faces:
        if f.normal.z > 0.9 and f.calc_center_median().z < PEDESTAL_H - 0.01:
            f.material_index = 2
    ob = dtx3d.object_from_bmesh("Reactor_Pedestal", bm, [mats["metal"], mats["ring"], mats["floor"]])
    dtx3d.add_bevel(ob, 0.015)
    dtx3d.smooth_by_angle(ob)
    return ob


def build_core(mats):
    """Noyau : gemme facettee (ombrage plat volontaire) + cage filaire + colonne d'energie."""
    core = dtx3d.object_from_bmesh("Reactor_Core", dtx3d.icosphere_bmesh(0.34, (0.0, 0.0, CORE_Z), 2), [mats["core"]])

    cage = dtx3d.object_from_bmesh("Reactor_Cage", dtx3d.icosphere_bmesh(0.52, (0.0, 0.0, 0.0), 1), [mats["metal_light"]])
    cage.location.z = CORE_Z  # origine au centre du noyau : le web la fait tourner sur place
    wire = cage.modifiers.new("Wire", "WIREFRAME")
    wire.thickness = 0.018
    wire.use_even_offset = True
    wire.use_replace = True

    beam_h = CORE_Z - 0.34 - (PEDESTAL_H - 0.02)
    beam = dtx3d.object_from_bmesh(
        "Reactor_Beam",
        dtx3d.cylinder_bmesh(0.045, beam_h, (0.0, 0.0, PEDESTAL_H - 0.02 + beam_h / 2), segments=16),
        [mats["beam"]],
    )
    return [core, cage, beam]


def build_gimbals(mats):
    """Deux cardans lumineux croises autour du noyau (origine au centre pour tourner sur place)."""
    gimbals = []
    for name, rot in (("Reactor_Gimbal_A", (math.radians(90), 0.0, math.radians(25))),
                      ("Reactor_Gimbal_B", (math.radians(90), 0.0, math.radians(-65)))):
        ob = dtx3d.object_from_bmesh(name, dtx3d.torus_bmesh(0.72, 0.008, major_segments=64, minor_segments=4), [mats["gimbal"]])
        ob.location.z = CORE_Z
        ob.rotation_euler = rot
        gimbals.append(ob)
    return gimbals


def build_shells(mats):
    """Orbites de severite : fils fins dans le plan du noyau, un materiau par severite."""
    shells = []
    for sev, radius in ORBIT_RADII.items():
        ob = dtx3d.object_from_bmesh(
            f"Reactor_Shell_{sev}",
            dtx3d.torus_bmesh(radius, 0.006, (0.0, 0.0, CORE_Z), major_segments=96, minor_segments=3),
            [mats[f"shell_{sev}"]],
        )
        ob["severity"] = sev  # glTF extras -> userData.severity
        shells.append(ob)
    return shells


def main():
    scene = dtx3d.reset_scene()
    mats = build_materials()
    parts = [build_pedestal(mats)] + build_core(mats) + build_gimbals(mats) + build_shells(mats)
    dtx3d.root_empty("Reactor_Widget", parts)

    dtx3d.camera_persp(scene, location=(0.0, -5.6, 3.1), target=(0.0, 0.0, 0.85), lens=50)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.8), scale=1.5)
    dtx3d.finish("reactor", __file__, scene, parts)


if __name__ == "__main__":
    main()
