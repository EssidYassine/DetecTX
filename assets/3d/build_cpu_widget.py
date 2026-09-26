"""
build_cpu_widget.py - Puce CPU 3D du dashboard DeTecTX (bandeau hote de l'Overview).

Usage : blender --background --python assets/3d/build_cpu_widget.py

Contrat avec le composant web (frontend/src/components/three/cpu-chip.tsx) :
    CPU_Widget (racine), CPU_Core_00..11 (userData.core_index), MAT_Ring (anneau teinte
    selon la posture), MAT_EmitEmerald (pistes, pulsation reseau). Ne pas renommer sans
    mettre a jour le composant.
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

# --------------------------------------------------------------------------- dimensions (m)
SUB_SIZE, SUB_H = 2.0, 0.12  # substrat (circuit imprime)
IHS_SIZE, IHS_H = 1.3, 0.14  # capot metal
IHS_TOP = SUB_H + IHS_H  # 0.26
BORDER, RING, RECESS = 0.12, 0.03, 0.025  # insets du capot + profondeur de la fenetre
ROW_COUNT, ROW_STEP, ROW_START = 9, 0.15, -0.6  # rangees de contacts (restent dans +/-0.65)


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["die"] = dtx3d.make_material("MAT_Die", "#03100d", roughness=0.15)
    mats["core"] = dtx3d.make_material("MAT_Core", "#000000", roughness=0.4, emission=dtx3d.EMERALD, strength=2.0)
    mats["ring"] = dtx3d.make_material("MAT_Ring", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=3.0)
    mats["logo"] = dtx3d.make_material("MAT_Logo", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=0.9)
    return mats


def build_substrate(mats):
    bm = dtx3d.box_bmesh((SUB_SIZE, SUB_SIZE, SUB_H), (0.0, 0.0, SUB_H / 2))
    ob = dtx3d.object_from_bmesh("CPU_Substrate", bm, [mats["substrate"]])
    dtx3d.add_bevel(ob, 0.02)
    dtx3d.smooth_by_angle(ob)
    return ob


def build_ihs(mats):
    """Capot : bordure metal, anneau neon, fenetre en retrait sur le die sombre."""
    bm = dtx3d.box_bmesh((IHS_SIZE, IHS_SIZE, IHS_H), (0.0, 0.0, SUB_H + IHS_H / 2))
    top = dtx3d.top_face(bm)
    # use_even_offset : sans lui, l'epaisseur est reduite d'un facteur ~0.707 dans les coins.
    bmesh.ops.inset_region(bm, faces=[top], thickness=BORDER, depth=0.0, use_even_offset=True)
    ring = bmesh.ops.inset_region(bm, faces=[top], thickness=RING, depth=0.0, use_even_offset=True)["faces"]
    for f in ring:
        f.material_index = 1  # anneau neon

    ret = bmesh.ops.extrude_face_region(bm, geom=[top])
    new_verts = [g for g in ret["geom"] if isinstance(g, bmesh.types.BMVert)]
    bmesh.ops.translate(bm, vec=Vector((0.0, 0.0, -RECESS)), verts=new_verts)
    bmesh.ops.delete(bm, geom=[top], context="FACES")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    for f in bm.faces:  # fond de la fenetre = die (les murs du retrait restent en metal)
        if f.normal.z > 0.9 and f.calc_center_median().z < IHS_TOP - 0.01:
            f.material_index = 2

    ob = dtx3d.object_from_bmesh("CPU_IHS", bm, [mats["metal"], mats["ring"], mats["die"]])
    dtx3d.add_bevel(ob, 0.012)
    dtx3d.smooth_by_angle(ob)
    return ob


def build_cores(mats, cols=4, rows=3):
    """Grille de coeurs lumineux : un objet par coeur (CPU_Core_00..), pilotable cote web."""
    floor_z = IHS_TOP - RECESS + 0.002
    half_w, half_h = 0.085, 0.10
    cores = []
    for r in range(rows):
        for c in range(cols):
            x = (c - (cols - 1) / 2) * 0.21
            y = (r - (rows - 1) / 2) * 0.26
            bm = bmesh.new()
            quad = [
                bm.verts.new((x - half_w, y - half_h, floor_z)),
                bm.verts.new((x + half_w, y - half_h, floor_z)),
                bm.verts.new((x + half_w, y + half_h, floor_z)),
                bm.verts.new((x - half_w, y + half_h, floor_z)),
            ]
            bm.faces.new(quad)  # ordre anti-horaire -> normale vers +Z
            index = r * cols + c
            core = dtx3d.object_from_bmesh(f"CPU_Core_{index:02d}", bm, [mats["core"]])
            core["core_index"] = index  # glTF extras -> userData.core_index cote Three.js
            cores.append(core)
    return cores


def add_array_mirror(ob):
    """9 exemplaires le long de X, puis symetrie sur Y autour du centre de la puce."""
    arr = ob.modifiers.new("Array", "ARRAY")
    arr.count = ROW_COUNT
    arr.use_relative_offset = False
    arr.use_constant_offset = True
    arr.constant_offset_displace = (ROW_STEP, 0.0, 0.0)
    mir = ob.modifiers.new("Mirror", "MIRROR")
    mir.use_axis = (False, True, False)


def build_row(name, dims, center, mat):
    """Une rangee (Array + Mirror) et sa copie tournee de 90 deg pour les deux autres cotes."""
    ob = dtx3d.object_from_bmesh(name, dtx3d.box_bmesh(dims, center), [mat])
    add_array_mirror(ob)
    ob_x = dtx3d.link(bpy.data.objects.new(name + "_X", ob.data))
    ob_x.rotation_euler.z = math.pi / 2
    add_array_mirror(ob_x)
    return [ob, ob_x]


def build_pin1(mats):
    """Repere 'pin 1' : triangle pointe vers le coin (-X, -Y), normale vers +Z."""
    bm = bmesh.new()
    center, radius = Vector((-0.82, -0.82, 0.124)), 0.05
    verts = [
        bm.verts.new(center + Vector((radius * math.cos(math.radians(a)), radius * math.sin(math.radians(a)), 0)))
        for a in (105, 225, 345)
    ]
    bm.faces.new(verts)
    return dtx3d.object_from_bmesh("CPU_Pin1", bm, [mats["cyan"]])


def main():
    scene = dtx3d.reset_scene()
    mats = build_materials()

    parts = [build_substrate(mats), build_ihs(mats)]
    parts += build_cores(mats)
    parts += build_row("CPU_Pads", (0.08, 0.10, 0.02), (ROW_START, -0.9, 0.131), mats["metal_light"])
    parts += build_row("CPU_Traces", (0.014, 0.24, 0.006), (ROW_START, -0.74, 0.124), mats["emerald"])
    parts.append(build_pin1(mats))
    # Signature sur la bordure avant (-Y) du capot, face a la camera isometrique.
    parts.append(
        dtx3d.text_mesh("CPU_Logo", "DeTecTX", 0.07, (0.0, -(IHS_SIZE / 2 - BORDER / 2), IHS_TOP + 0.001), mats["logo"])
    )
    dtx3d.root_empty("CPU_Widget", parts)

    dtx3d.camera_iso(scene, ortho_scale=3.3)
    dtx3d.studio(scene)
    dtx3d.finish("cpu_widget", __file__, scene, parts)


if __name__ == "__main__":
    main()
