"""
build_lock.py - « La Serrure » : le durcissement du poste (page Systeme, vue Durcissement).

Une porte de coffre circulaire vue de face, dans son cadre. Le web y pose un PENE par controle
de durcissement, rayonnant autour du volant : engage dans le cadre (protege) ou retracte vers
le centre (a renforcer). Le volant tourne selon la note ; la note s'affiche au centre.

Usage : blender --background --python assets/3d/build_lock.py

Contrat avec le composant web (frontend/src/components/three/lock.tsx) :
    Lock_Widget (racine), Lock_Wheel (groupe du volant, tourne autour de l'axe de la porte),
    Bolt_Template (pene modele, masque par le web qui l'instancie ; barre le long de +X,
    centree a l'origine), MAT_DoorRim (liseré, teinte selon la note), MAT_Bolt.
    DOOR_R, BOLT_Y, BOLT_IN, BOLT_OUT : repris par le composant (conversion glTF :
    (x, y, z) Blender -> (x, z, -y) ; la porte fait face a -Y Blender, donc +Z glTF).
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

DOOR_R, DOOR_D = 1.55, 0.26
FRAME_R = 2.05
BOLT_Y = -0.19  # plan des penes, devant la face de la porte
BOLT_LEN = 0.62
BOLT_IN = (0.86, 1.48)  # rayons (debut, fin) d'un pene retracte
BOLT_OUT = (1.3, 1.92)  # rayons d'un pene engage (mord dans le cadre)
FACE = Matrix.Rotation(math.pi / 2, 4, "X")  # Z -> -Y : les disques font face a la camera


def facing(bm):
    """Oriente vers la camera (-Y) une geometrie construite autour de l'axe Z."""
    bmesh.ops.transform(bm, matrix=FACE, verts=bm.verts)
    bm.normal_update()
    return bm


def disc(radius, depth, y, segments=96):
    return facing(dtx3d.cylinder_bmesh(radius, depth, (0.0, 0.0, -y), segments=segments))


def ring(major, minor, y, segments=128, minor_segments=8):
    return facing(dtx3d.torus_bmesh(major, minor, (0.0, 0.0, -y), segments, minor_segments))


def build(mats):
    parts = []
    # Cadre : anneau massif + liseré ; la porte s'y loge.
    frame = dtx3d.object_from_bmesh("Lock_Frame", disc(FRAME_R + 0.28, 0.34, 0.1, 128), [mats["frame"]])
    dtx3d.add_bevel(frame, 0.03, 2)
    dtx3d.smooth_by_angle(frame)
    parts.append(frame)
    parts.append(dtx3d.object_from_bmesh("Lock_FrameRim", ring(FRAME_R + 0.28, 0.02, -0.08), [mats["rim_frame"]]))
    parts.append(dtx3d.object_from_bmesh("Lock_Recess", disc(FRAME_R, 0.02, -0.08, 128), [mats["recess"]]))
    # Porte + liseré (teinte = note) + graduations.
    door = dtx3d.object_from_bmesh("Lock_Door", disc(DOOR_R, DOOR_D, -0.02, 128), [mats["door"]])
    dtx3d.add_bevel(door, 0.04, 3)
    dtx3d.smooth_by_angle(door)
    parts.append(door)
    parts.append(dtx3d.object_from_bmesh("Lock_DoorRim", ring(DOOR_R - 0.06, 0.016, -0.16), [mats["door_rim"]]))
    parts.append(dtx3d.object_from_bmesh("Lock_DoorInner", ring(0.78, 0.01, -0.155, 96, 6), [mats["line"]]))
    for k in range(60):
        a = 2 * math.pi * k / 60
        long_tick = k % 5 == 0
        r0, r1 = (1.28, 1.4) if long_tick else (1.33, 1.4)
        bm = dtx3d.box_bmesh(((r1 - r0), 0.01, 0.018 if long_tick else 0.01), ((r0 + r1) / 2, -0.16, 0.0))
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0.0, 0.0, 0.0), matrix=Matrix.Rotation(a, 3, "Y"))
        parts.append(dtx3d.object_from_bmesh(f"Lock_Tick_{k:02d}", bm, [mats["line"] if long_tick else mats["tick"]]))
    # Volant : moyeu + couronne + 4 rayons, groupe qui tourne d'un bloc.
    wheel = dtx3d.link(bpy.data.objects.new("Lock_Wheel", None))
    wheel.empty_display_type = "PLAIN_AXES"
    hub = dtx3d.object_from_bmesh("Lock_WheelHub", disc(0.3, 0.22, -0.28, 64), [mats["wheel"]])
    dtx3d.add_bevel(hub, 0.03, 3)
    dtx3d.smooth_by_angle(hub)
    crown = dtx3d.object_from_bmesh("Lock_WheelCrown", ring(0.62, 0.05, -0.36, 128, 12), [mats["wheel"]])
    dtx3d.smooth_by_angle(crown, 60)
    wheel_parts = [hub, crown]
    for k in range(4):
        bm = dtx3d.box_bmesh((0.62 - 0.26, 0.06, 0.07), (0.26 + (0.62 - 0.26) / 2, -0.33, 0.0))
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0.0, 0.0, 0.0), matrix=Matrix.Rotation(k * math.pi / 2 + math.pi / 4, 3, "Y"))
        spoke = dtx3d.object_from_bmesh(f"Lock_WheelSpoke_{k}", bm, [mats["wheel"]])
        dtx3d.add_bevel(spoke, 0.012, 2)
        wheel_parts.append(spoke)
        knob = dtx3d.object_from_bmesh(f"Lock_WheelKnob_{k}", dtx3d.icosphere_bmesh(0.07, (0.0, 0.0, 0.0), 2), [mats["wheel_knob"]])
        a = k * math.pi / 2 + math.pi / 4
        knob.location = (0.62 * math.cos(a), -0.36, -0.62 * math.sin(a))
        wheel_parts.append(knob)
    hub_cap = dtx3d.object_from_bmesh("Lock_WheelCap", disc(0.2, 0.02, -0.4, 64), [mats["door_rim"]])
    wheel_parts.append(hub_cap)
    for ob in wheel_parts:
        ob.parent = wheel
    parts.append(wheel)
    # Pene modele (instancie par le web) : cache derriere le moyeu dans l'apercu.
    bolt = dtx3d.object_from_bmesh("Bolt_Template", dtx3d.box_bmesh((BOLT_LEN, 0.1, 0.13), (0.0, 0.0, 0.0)), [mats["bolt"]])
    dtx3d.add_bevel(bolt, 0.025, 3)
    bolt.location = (0.0, 0.05, 0.0)
    parts.append(bolt)
    return parts, wheel_parts


def preview_bolts(mats, count=18):
    """Penes d'apercu (rendu Blender seulement : le web les pose lui-meme)."""
    out = []
    for k in range(count):
        a = 2 * math.pi * k / count
        r0, r1 = BOLT_OUT if k % 4 else BOLT_IN
        bm = dtx3d.box_bmesh((r1 - r0, 0.1, 0.13), ((r0 + r1) / 2, BOLT_Y, 0.0))
        bmesh.ops.rotate(bm, verts=bm.verts, cent=(0.0, 0.0, 0.0), matrix=Matrix.Rotation(a, 3, "Y"))
        out.append(dtx3d.object_from_bmesh(f"Preview_Bolt_{k:02d}", bm, [mats["bolt"] if k % 4 else mats["bolt_weak"]]))
    return out


def main():
    scene = dtx3d.reset_scene()
    mats = dtx3d.base_materials()
    mats["frame"] = dtx3d.make_material("MAT_LockFrame", "#1b2027", metallic=1.0, roughness=0.3)
    mats["recess"] = dtx3d.make_material("MAT_LockRecess", "#050709", roughness=0.8)
    mats["door"] = dtx3d.make_material("MAT_LockDoor", "#232a33", metallic=1.0, roughness=0.26)
    mats["wheel"] = dtx3d.make_material("MAT_LockWheel", "#8c96a3", metallic=1.0, roughness=0.22)
    mats["wheel_knob"] = dtx3d.make_material("MAT_LockKnob", "#c9a36b", metallic=1.0, roughness=0.25)
    mats["door_rim"] = dtx3d.make_material("MAT_DoorRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.4)
    mats["rim_frame"] = dtx3d.make_material("MAT_FrameRim", "#000000", roughness=0.4, emission="#8a97a9", strength=0.7)
    mats["line"] = dtx3d.make_material("MAT_LockLine", "#000000", roughness=0.4, emission="#8a97a9", strength=1.1)
    mats["tick"] = dtx3d.make_material("MAT_LockTick", "#000000", roughness=0.4, emission="#56606d", strength=0.8)
    mats["bolt"] = dtx3d.make_material("MAT_Bolt", "#b8c2cc", metallic=1.0, roughness=0.2, emission=dtx3d.ACCENT, strength=0.25)
    mats["bolt_weak"] = dtx3d.make_material("MAT_BoltWeak", "#b8c2cc", metallic=1.0, roughness=0.2, emission="#fbbf77", strength=0.6)
    parts, wheel_parts = build(mats)
    preview = preview_bolts(mats)
    dtx3d.root_empty("Lock_Widget", parts)
    dtx3d.camera_persp(scene, location=(1.3, -12.0, 1.5), target=(0.0, 0.0, 0.0), lens=48)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.0), scale=1.7)
    meshes = [p for p in parts if p.type == "MESH"] + wheel_parts
    # Glb sans les penes d'apercu ; rendus avec (le web les pose selon les controles).
    src, web = dtx3d.paths(__file__)
    collection = bpy.context.scene.collection
    for ob in preview:  # l'export glTF inclut aussi les objets masques : on les retire de la scene
        collection.objects.unlink(ob)
    print(f"[lock] triangles (modificateurs appliques) : {dtx3d.count_triangles(meshes)}")
    dtx3d.export_glb(os.path.join(web, "lock.glb"))
    for ob in preview:
        collection.objects.link(ob)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(src, "lock.blend"))
    dtx3d.render(scene, os.path.join(src, "lock_preview.png"), (1200, 900))
    dtx3d.render(scene, os.path.join(web, "lock_poster.png"), (900, 675), transparent=True)
    print(f"[lock] termine -> {src} + {web}")


if __name__ == "__main__":
    main()
