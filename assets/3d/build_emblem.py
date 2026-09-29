"""
build_emblem.py - Emblème 3D de la barre latérale DeTecTX (le « cristal » du poste).

Un cristal hexagonal (bipyramide a facettes) en verre, un coeur lumineux a l'interieur et un
anneau orbital. Le web le fait tourner lentement et le teinte selon la posture globale
(accent / ambre / rouge) ; le coeur pulse plus vite en alerte.

Usage : blender --background --python assets/3d/build_emblem.py

Contrat avec le composant web (frontend/src/components/three/emblem.tsx) :
    Emblem_Widget (racine), Emblem_Gem (MAT_EmblemGlass), Emblem_Edges (MAT_EmblemEdge),
    Emblem_Core (MAT_EmblemCore), Emblem_Ring (MAT_EmblemRing).
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

R = 0.62  # rayon de la ceinture du cristal
TOP, BOTTOM = 0.78, -0.62  # sommets (le haut plus elance)


def gem_points() -> tuple[list[Vector], Vector, Vector]:
    belt = [Vector((R * math.cos(math.pi / 6 + i * math.pi / 3), R * math.sin(math.pi / 6 + i * math.pi / 3), 0.0)) for i in range(6)]
    return belt, Vector((0.0, 0.0, TOP)), Vector((0.0, 0.0, BOTTOM))


def gem_bmesh() -> bmesh.types.BMesh:
    belt, top, bottom = gem_points()
    bm = bmesh.new()
    vb = [bm.verts.new(p) for p in belt]
    vt, vd = bm.verts.new(top), bm.verts.new(bottom)
    for i in range(6):
        j = (i + 1) % 6
        bm.faces.new((vb[i], vb[j], vt))
        bm.faces.new((vb[j], vb[i], vd))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return bm


def edges_bmesh(radius: float = 0.018) -> bmesh.types.BMesh:
    """Aretes du cristal en fins cylindres : les facettes restent lisibles meme en tout petit."""
    belt, top, bottom = gem_points()
    segments = [(belt[i], belt[(i + 1) % 6]) for i in range(6)] + [(p, top) for p in belt] + [(p, bottom) for p in belt]
    bm = bmesh.new()
    for a, b in segments:
        d = b - a
        piece = bmesh.new()
        bmesh.ops.create_cone(piece, cap_ends=True, segments=6, radius1=radius, radius2=radius, depth=d.length)
        rot = Vector((0, 0, 1)).rotation_difference(d.normalized()).to_matrix().to_4x4()
        bmesh.ops.transform(piece, matrix=rot, verts=piece.verts)
        bmesh.ops.translate(piece, vec=(a + b) / 2, verts=piece.verts)
        me = bpy.data.meshes.new("tmp_edge")
        piece.to_mesh(me)
        piece.free()
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)
    return bm


def build(mats):
    parts = [
        dtx3d.object_from_bmesh("Emblem_Gem", gem_bmesh(), [mats["glass"]]),
        dtx3d.object_from_bmesh("Emblem_Edges", edges_bmesh(), [mats["edge"]]),
        dtx3d.object_from_bmesh("Emblem_Core", dtx3d.icosphere_bmesh(0.2, (0.0, 0.0, 0.04), subdivisions=2), [mats["core"]]),
        dtx3d.object_from_bmesh("Emblem_Ring", dtx3d.torus_bmesh(0.92, 0.016, (0.0, 0.0, 0.0), 96, 6), [mats["ring"]]),
    ]
    parts[1].data.polygons.foreach_set("use_smooth", [True] * len(parts[1].data.polygons))
    return parts


def main():
    scene = dtx3d.reset_scene()
    mats = {
        "glass": dtx3d.make_material("MAT_EmblemGlass", "#2dd4bf", roughness=0.05, emission=dtx3d.ACCENT, strength=0.35, alpha=0.28),
        "edge": dtx3d.make_material("MAT_EmblemEdge", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.6),
        "core": dtx3d.make_material("MAT_EmblemCore", "#000000", roughness=0.2, emission="#fbbf77", strength=4.5),
        "ring": dtx3d.make_material("MAT_EmblemRing", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.6),
    }
    parts = build(mats)
    parts[3].rotation_euler = (math.radians(72), 0.0, math.radians(18))  # anneau incline
    dtx3d.root_empty("Emblem_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -3.6, 1.1), target=(0.0, 0.0, 0.05), lens=50)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.0), scale=0.8)
    dtx3d.finish("emblem", __file__, scene, parts, preview_res=(600, 600), poster_res=(256, 256))


if __name__ == "__main__":
    main()
