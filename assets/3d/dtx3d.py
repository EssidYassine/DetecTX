"""
dtx3d.py - Bibliotheque partagee des generateurs 3D DeTecTX (Blender 4.1+ / 5.x).

Chaque composant du dashboard a son script (build_<nom>.py) qui importe ce module :
meme palette, memes materiaux Principled BSDF (export glTF fidele), meme studio,
meme export. Resultat : des widgets visuellement coherents entre eux.

Conventions de sortie :
    assets/3d/<nom>.blend, assets/3d/<nom>_preview.png   (sources et apercus)
    frontend/public/models/<nom>.glb                      (modele web)
    frontend/public/models/<nom>_poster.png               (affiche transparente)
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Euler, Vector

# --------------------------------------------------------------------------- palette
EMERALD = "#10b981"
CYAN = "#22d3ee"
ACCENT = "#2dd4bf"  # accent du dashboard (teinte surchargee au runtime selon le theme/posture)
BACKGROUND = "#090c12"  # fond du dashboard, pour les apercus


def hex_to_linear(value: str, alpha: float = 1.0) -> tuple:
    """Couleur hex sRGB -> RGBA lineaire (espace attendu par les sockets Blender)."""
    value = value.lstrip("#")
    srgb = [int(value[i : i + 2], 16) / 255 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in srgb]
    return (*lin, alpha)


# --------------------------------------------------------------------------- chemins
def paths(script_file: str) -> tuple[str, str]:
    """(dossier source assets/3d, dossier web frontend/public/models) ; argument '--' prioritaire."""
    src = os.path.dirname(os.path.abspath(script_file))
    if "--" in sys.argv:
        args = sys.argv[sys.argv.index("--") + 1 :]
        if args:
            src = os.path.abspath(args[0])
    repo = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(script_file))))
    web = os.path.join(repo, "frontend", "public", "models")
    if not os.path.isdir(os.path.join(repo, "frontend", "public")):
        web = src
    os.makedirs(src, exist_ok=True)
    os.makedirs(web, exist_ok=True)
    return src, web


# --------------------------------------------------------------------------- scene
def reset_scene() -> bpy.types.Scene:
    """Scene vide en unites metriques, sans toucher au script ouvert dans Blender."""
    for ob in list(bpy.data.objects):
        bpy.data.objects.remove(ob, do_unlink=True)
    for coll in (bpy.data.meshes, bpy.data.materials, bpy.data.lights, bpy.data.cameras, bpy.data.curves):
        for block in list(coll):
            if block.users == 0:
                coll.remove(block)
    scene = bpy.context.scene
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1.0
    return scene


def link(ob):
    bpy.context.scene.collection.objects.link(ob)
    return ob


def root_empty(name: str, parts) -> bpy.types.Object:
    """Racine unique a l'origine (le runtime web anime ce noeud)."""
    root = link(bpy.data.objects.new(name, None))
    root.empty_display_type = "PLAIN_AXES"
    for ob in parts:
        ob.parent = root  # racine a l'origine : aucune correction de matrice necessaire
    return root


# --------------------------------------------------------------------------- materiaux
def principled(mat):
    if mat.node_tree is None:  # Blender 4.x ; en 5.x l'arbre de noeuds existe toujours
        mat.use_nodes = True
    return next(n for n in mat.node_tree.nodes if n.type == "BSDF_PRINCIPLED")


def make_material(name, base, metallic=0.0, roughness=0.5, emission=None, strength=0.0):
    mat = bpy.data.materials.new(name)
    bsdf = principled(mat)
    bsdf.inputs["Base Color"].default_value = hex_to_linear(base)
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        key = "Emission Color" if "Emission Color" in bsdf.inputs else "Emission"
        bsdf.inputs[key].default_value = hex_to_linear(emission)
        bsdf.inputs["Emission Strength"].default_value = strength
    return mat


def base_materials() -> dict:
    """Materiaux communs a tous les widgets (quasi-noirs + metal ; la couleur aux neons)."""
    return {
        "substrate": make_material("MAT_Substrate", "#050807", roughness=0.55),
        "metal": make_material("MAT_MetalDark", "#15191e", metallic=1.0, roughness=0.32),
        "metal_light": make_material("MAT_Contacts", "#5c6670", metallic=1.0, roughness=0.35),
        "emerald": make_material("MAT_EmitEmerald", "#000000", roughness=0.4, emission=EMERALD, strength=1.6),
        "cyan": make_material("MAT_EmitCyan", "#000000", roughness=0.4, emission=CYAN, strength=3.0),
    }


# --------------------------------------------------------------------------- geometrie
def box_bmesh(dims, center) -> bmesh.types.BMesh:
    """Pave aux dimensions exactes, geometrie deja placee (origine de l'objet au centre du monde)."""
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    for v in bm.verts:
        v.co = Vector(
            (v.co.x * dims[0] + center[0], v.co.y * dims[1] + center[1], v.co.z * dims[2] + center[2])
        )
    bm.normal_update()
    return bm


def cylinder_bmesh(radius, depth, center, segments=48) -> bmesh.types.BMesh:
    bm = bmesh.new()
    bmesh.ops.create_cone(
        bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=depth
    )
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    bm.normal_update()
    return bm


def torus_bmesh(major, minor, center=(0.0, 0.0, 0.0), major_segments=64, minor_segments=4) -> bmesh.types.BMesh:
    """Tore dans le plan XY (anneaux, orbites). Peu de segments mineurs = fil fin et leger."""
    bm = bmesh.new()
    grid = []
    for i in range(major_segments):
        a = 2 * math.pi * i / major_segments
        row = []
        for j in range(minor_segments):
            b = 2 * math.pi * j / minor_segments
            ring = major + minor * math.cos(b)
            row.append(
                bm.verts.new((center[0] + ring * math.cos(a), center[1] + ring * math.sin(a), center[2] + minor * math.sin(b)))
            )
        grid.append(row)
    for i in range(major_segments):
        for j in range(minor_segments):
            i2, j2 = (i + 1) % major_segments, (j + 1) % minor_segments
            bm.faces.new((grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.normal_update()
    return bm


def icosphere_bmesh(radius, center, subdivisions=2) -> bmesh.types.BMesh:
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius)
    bmesh.ops.translate(bm, vec=Vector(center), verts=bm.verts)
    bm.normal_update()
    return bm


def object_from_bmesh(name, bm, materials):
    me = bpy.data.meshes.new(name)
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for mat in materials:
        me.materials.append(mat)
    return link(bpy.data.objects.new(name, me))


def top_face(bm):
    return max((f for f in bm.faces if f.normal.z > 0.9), key=lambda f: f.calc_center_median().z)


def add_bevel(ob, width, segments=2):
    mod = ob.modifiers.new("Bevel", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(30)
    mod.harden_normals = True


def smooth_by_angle(ob, degrees=30):
    """Lissage par angle (Blender 4.1+) ; reste en ombrage plat si indisponible."""
    try:
        with bpy.context.temp_override(
            object=ob, active_object=ob, selected_objects=[ob], selected_editable_objects=[ob]
        ):
            bpy.ops.object.shade_smooth_by_angle(angle=math.radians(degrees))
    except Exception as exc:  # noqa: BLE001 - un ombrage plat reste acceptable
        print(f"[dtx3d] lissage ignore pour {ob.name}: {exc}")


def text_mesh(name, body, size, location, material, rotation_z=0.0, align="CENTER"):
    """Texte converti en maillage basse resolution (gravures, graduations)."""
    curve = bpy.data.curves.new(name + "_Text", "FONT")
    curve.body = body
    curve.size = size
    curve.align_x = align
    curve.align_y = "CENTER"
    curve.resolution_u = 2  # courbes grossieres = peu de triangles
    curve.font = bpy.data.fonts.get("Bfont Regular") or bpy.data.fonts.load("<builtin>")
    text_ob = link(bpy.data.objects.new(name + "_Text", curve))
    text_ob.location = location
    text_ob.rotation_euler.z = rotation_z

    depsgraph = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(text_ob.evaluated_get(depsgraph))
    loc, rot = text_ob.location.copy(), text_ob.rotation_euler.copy()
    bpy.data.objects.remove(text_ob, do_unlink=True)
    bpy.data.curves.remove(curve)

    mesh.materials.clear()
    mesh.materials.append(material)
    ob = link(bpy.data.objects.new(name, mesh))
    ob.location, ob.rotation_euler = loc, rot
    return ob


def count_triangles(objects) -> int:
    depsgraph = bpy.context.evaluated_depsgraph_get()
    total = 0
    for ob in objects:
        if ob.type != "MESH":
            continue
        evaluated = ob.evaluated_get(depsgraph)
        mesh = evaluated.to_mesh()
        mesh.calc_loop_triangles()
        total += len(mesh.loop_triangles)
        evaluated.to_mesh_clear()
    return total


# --------------------------------------------------------------------------- studio
def look_at(ob, target):
    direction = Vector(target) - ob.location
    ob.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def camera_iso(scene, ortho_scale, target_z=0.13):
    """Camera orthographique isometrique vraie (54.736 deg, 45 deg)."""
    data = bpy.data.cameras.new("IsoCam")
    data.type = "ORTHO"
    data.ortho_scale = ortho_scale
    data.clip_end = 100.0
    cam = link(bpy.data.objects.new("IsoCam", data))
    rot = Euler((math.radians(54.736), 0.0, math.radians(45.0)))
    cam.rotation_euler = rot
    cam.location = Vector((0.0, 0.0, target_z)) + rot.to_matrix() @ Vector((0.0, 0.0, 10.0))
    scene.camera = cam
    return cam


def camera_persp(scene, location, target, lens=50.0):
    data = bpy.data.cameras.new("PerspCam")
    data.lens = lens
    data.clip_end = 100.0
    cam = link(bpy.data.objects.new("PerspCam", data))
    cam.location = location
    look_at(cam, target)
    scene.camera = cam
    return cam


def area_light(name, location, color, energy, size, target=(0.0, 0.0, 0.1)):
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.size = size
    data.color = hex_to_linear(color)[:3]
    ob = link(bpy.data.objects.new(name, data))
    ob.location = location
    look_at(ob, target)
    return ob


def studio(scene, target=(0.0, 0.0, 0.1), scale=1.0):
    """Studio sombre DeTecTX : cle neutre douce + contre-jours emeraude/cyan doses + appoint.
    `scale` agrandit les distances pour les objets plus grands que la puce."""
    s = scale
    area_light("Light_Key", (3.5 * s, -3.0 * s, 5.0 * s), "#e6edf5", 300 * s * s, 3.0 * s, target)
    area_light("Light_RimEmerald", (-3.5 * s, 2.5 * s, 1.6 * s), EMERALD, 200 * s * s, 2.0 * s, target)
    area_light("Light_RimCyan", (2.5 * s, 3.5 * s, 1.4 * s), CYAN, 380 * s * s, 2.0 * s, target)
    area_light("Light_Fill", (-2.5 * s, -3.5 * s, 2.0 * s), "#8fa3b8", 60 * s * s, 4.0 * s, target)

    world = scene.world or bpy.data.worlds.new("World")
    scene.world = world
    if world.node_tree is None:
        world.use_nodes = True
    bg = next(n for n in world.node_tree.nodes if n.type == "BACKGROUND")
    bg.inputs[0].default_value = hex_to_linear(BACKGROUND)
    bg.inputs[1].default_value = 1.0
    try:
        scene.view_settings.view_transform = "Standard"  # AgX delave les neons satures
    except TypeError:
        pass

    for engine in ("BLENDER_EEVEE_NEXT", "BLENDER_EEVEE"):
        try:
            scene.render.engine = engine
            break
        except TypeError:
            continue
    try:
        scene.eevee.taa_render_samples = 32
    except AttributeError:
        pass
    scene.render.image_settings.file_format = "PNG"


def render(scene, path, resolution=900, transparent=False):
    """`resolution` : entier (carre) ou (largeur, hauteur) pour les widgets allonges."""
    width, height = resolution if isinstance(resolution, tuple) else (resolution, resolution)
    scene.render.resolution_x, scene.render.resolution_y = width, height
    scene.render.film_transparent = transparent
    scene.render.image_settings.color_mode = "RGBA" if transparent else "RGB"
    scene.render.filepath = path
    try:
        bpy.ops.render.render(write_still=True)
    except RuntimeError as exc:
        print(f"[dtx3d] rendu EEVEE impossible ({exc}), bascule sur Cycles")
        scene.render.engine = "CYCLES"
        scene.cycles.samples = 48
        bpy.ops.render.render(write_still=True)


def export_glb(path):
    bpy.ops.export_scene.gltf(
        filepath=path,
        export_format="GLB",
        export_apply=True,
        export_extras=True,  # proprietes custom -> userData cote Three.js
        export_cameras=False,
        export_lights=False,
        export_yup=True,
    )
    print(f"[dtx3d] glb : {path} ({os.path.getsize(path) / 1024:.1f} Ko)")


def finish(name, script_file, scene, parts, preview_res=900, poster_res=640):
    """Pipeline de sortie commun : stats, glb web, .blend, apercu, affiche transparente."""
    src, web = paths(script_file)
    print(f"[{name}] triangles (modificateurs appliques) : {count_triangles(parts)}")
    export_glb(os.path.join(web, f"{name}.glb"))
    bpy.context.preferences.filepaths.save_version = 0  # pas de sauvegardes .blend1
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(src, f"{name}.blend"))
    render(scene, os.path.join(src, f"{name}_preview.png"), preview_res)
    render(scene, os.path.join(web, f"{name}_poster.png"), poster_res, transparent=True)
    print(f"[{name}] termine -> {src} + {web}")
