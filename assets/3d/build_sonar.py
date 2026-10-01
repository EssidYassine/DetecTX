"""
build_sonar.py - « Sonar » de la page Reseau DeTecTX (appareils du reseau local).

Une coupole de verre posee sur un plateau. Au centre la box (passerelle). Le plateau est divise
en 5 secteurs (type d'appareil) ; trois anneaux mesurent la CONFIANCE : approuve pres de la
box, connu au milieu, NOUVEAU sur l'anneau ambre en pointilles du bord (« a la porte »).
Le secteur « Inconnus » est face a la camera : c'est la qu'un intrus se voit le mieux.
Le web place un echo par appareil (silhouette Glyph_<type>, socle Glyph_Echo, mat Glyph_Stalk
dont la hauteur = exposition), fait tourner le faisceau et propage l'onde de ping pendant un scan.

Usage : blender --background --python assets/3d/build_sonar.py

Contrat avec le composant web (frontend/src/components/three/sonar.tsx) :
    Sonar_Widget (racine).
    Sonar_Sector_00..04 (userData.sector_index, userData.sector ; MAT_SonarSector clone par secteur).
    Sonar_Ring_Trusted / Sonar_Ring_Known / Sonar_Ring_New (anneaux de confiance).
    Sonar_Gateway (la box) + Sonar_GatewayCore (MAT_SonarCore : pulse avec l'activite).
    Sonar_Beam (faisceau, tourne autour de l'axe vertical, angle 0 = +X three).
    Sonar_Pulse (onde de ping, rayon 1 : le web l'agrandit de R_MIN a OUTER_R).
    Sonar_Dome, Sonar_DomeLines (coupole ; sans lancer de rayon cote web).
    Glyph_Library (empty) > Glyph_<type> pour chaque type de classify.KINDS sauf « gateway »,
    Glyph_Echo, Glyph_Stalk : centres a l'origine, base a z = 0, face -Y Blender (= +Z three,
    vers la camera). Le web masque la bibliotheque et en clone les geometries.
    Materiaux partages : MAT_GlyphBody, MAT_GlyphGlow (teinte par appareil cote web).
    Constantes ci-dessous (GROUND_TOP, R_MIN, OUTER_R, RING_*, DOME_*, SECTORS, START, STEP,
    GLYPH_SIZE) : reprises telles quelles par le composant.
    Hauteur d'un echo : jamais au-dessus de dome_z(r) - GLYPH_SIZE (sinon il traverse la coupole,
    surtout sur l'anneau « nouveau », ou la coupole est basse).

Reperes (comme build_radar.py) : point three (r, phi) -> Blender (r cos phi, -r sin phi).
"""

import math
import os
import sys

import bmesh
import bpy
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

PLATE_R, PLATE_H = 3.4, 0.1
GROUND_TOP = 0.11
R_MIN = 0.72  # bord de la zone de la box
OUTER_R = 3.05
RING_TRUSTED, RING_KNOWN, RING_NEW = 1.2, 1.95, 2.7
DOME_R, DOME_H = 3.2, 1.55  # coupole aplatie : les echos restent lisibles
SECTORS = ("computer", "mobile", "home", "iot", "unknown")  # home = imprimante, camera, TV, NAS
STEP = 2 * math.pi / len(SECTORS)
START = math.pi / 2 - 4.5 * STEP  # « unknown » (indice 4) centre face a la camera (phi = pi/2)
GAP = 0.02  # demi-ecart angulaire entre secteurs (rad)
GLYPH_SIZE = 0.48  # hauteur de reference d'une silhouette
AMBER = "#f59e0b"
GLYPH_KINDS = ("computer", "mobile", "printer", "camera", "media", "nas", "iot", "unknown")


def phi_of(i: float) -> float:
    return START + STEP * (i + 0.5)


def bl(phi: float, r: float, z: float) -> tuple:
    return (r * math.cos(phi), -r * math.sin(phi), z)


def dome_z(r: float) -> float:
    """Hauteur de la coupole (demi-ellipsoide) au rayon r."""
    return GROUND_TOP + DOME_H * math.sqrt(max(0.0, 1.0 - (r / DOME_R) ** 2))


# --------------------------------------------------------------------------- materiaux
def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_SonarGround", "#050b0d", roughness=0.85)
    mats["sector"] = dtx3d.make_material("MAT_SonarSector", "#0a1a1c", roughness=0.7, emission=dtx3d.ACCENT, strength=0.0)
    mats["trusted"] = dtx3d.make_material("MAT_RingTrusted", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.1)
    mats["known"] = dtx3d.make_material("MAT_RingKnown", "#000000", roughness=0.4, emission="#8a97a9", strength=0.4)
    mats["new"] = dtx3d.make_material("MAT_RingNew", "#000000", roughness=0.4, emission=AMBER, strength=1.4)
    mats["rim"] = dtx3d.make_material("MAT_SonarRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=0.6)
    mats["grid"] = dtx3d.make_material("MAT_SonarGrid", "#000000", roughness=0.4, emission="#8a97a9", strength=0.12)
    mats["core"] = dtx3d.make_material("MAT_SonarCore", "#000000", roughness=0.3, emission=dtx3d.ACCENT, strength=3.0)
    mats["dome"] = dtx3d.make_material("MAT_SonarDome", "#9fe7dc", roughness=0.08, emission=dtx3d.ACCENT, strength=0.05, alpha=0.05)
    mats["dome_lines"] = dtx3d.make_material("MAT_SonarDomeLines", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=0.35)
    mats["beam"] = dtx3d.make_material("MAT_SonarBeam", "#2dd4bf", roughness=0.2, emission=dtx3d.ACCENT, strength=0.7, alpha=0.11)
    mats["trail"] = dtx3d.make_material("MAT_SonarTrail", "#2dd4bf", roughness=0.2, emission=dtx3d.ACCENT, strength=0.3, alpha=0.05)
    mats["pulse"] = dtx3d.make_material("MAT_SonarPulse", "#2dd4bf", roughness=0.2, emission=dtx3d.ACCENT, strength=1.6, alpha=0.6)
    mats["glyph_body"] = dtx3d.make_material("MAT_GlyphBody", "#1b2128", metallic=0.9, roughness=0.3)
    mats["glyph_glow"] = dtx3d.make_material("MAT_GlyphGlow", "#000000", roughness=0.35, emission=dtx3d.ACCENT, strength=2.2)
    mats["echo"] = dtx3d.make_material("MAT_GlyphEcho", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.2, alpha=0.85)
    mats["stalk"] = dtx3d.make_material("MAT_GlyphStalk", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.0, alpha=0.55)
    return mats


# --------------------------------------------------------------------------- geometrie
def annular_sector(bm, r0, r1, a0, a1, z0, h, segments=12, material_index=0):
    """Prisme en portion d'anneau (angles three a0 -> a1), sol a z0, epaisseur h."""
    top, bottom = [], []
    for k in range(segments + 1):
        a = a0 + (a1 - a0) * k / segments
        top.append((bm.verts.new(bl(a, r0, z0 + h)), bm.verts.new(bl(a, r1, z0 + h))))
        bottom.append((bm.verts.new(bl(a, r0, z0)), bm.verts.new(bl(a, r1, z0))))
    faces = []
    for k in range(segments):
        (ti, to), (ti2, to2) = top[k], top[k + 1]
        (bi, bo), (bi2, bo2) = bottom[k], bottom[k + 1]
        faces += [bm.faces.new((ti, to, to2, ti2)), bm.faces.new((bi2, bo2, bo, bi)), bm.faces.new((to, bo, bo2, to2)), bm.faces.new((ti2, bi2, bi, ti))]
    for (ti, to), (bi, bo) in ((top[0], bottom[0]), (top[-1], bottom[-1])):
        faces.append(bm.faces.new((ti, bi, bo, to)))
    for f in faces:
        f.material_index = material_index
    return faces


def _tag(bm, index, draw):
    """Dessine dans `bm` et affecte l'indice de materiau `index` aux faces creees."""
    before = set(bm.faces)
    draw()
    for f in set(bm.faces) - before:
        f.material_index = index


def add_box(bm, dims, center, rot_z=0.0, mat=0):
    matrix = Matrix.Translation(Vector(center)) @ Matrix.Rotation(rot_z, 4, "Z") @ Matrix.Diagonal((*dims, 1.0))
    _tag(bm, mat, lambda: bmesh.ops.create_cube(bm, size=1.0, matrix=matrix))


def add_cylinder(bm, radius, depth, center, segments=16, axis="Z", mat=0):
    rot = {"Z": Matrix.Identity(4), "Y": Matrix.Rotation(math.pi / 2, 4, "X"), "X": Matrix.Rotation(math.pi / 2, 4, "Y")}[axis]
    matrix = Matrix.Translation(Vector(center)) @ rot
    _tag(bm, mat, lambda: bmesh.ops.create_cone(bm, cap_ends=True, cap_tris=False, segments=segments, radius1=radius, radius2=radius, depth=depth, matrix=matrix))


def add_ico(bm, radius, center, subdivisions=2, stretch_z=1.0, mat=0):
    matrix = Matrix.Translation(Vector(center)) @ Matrix.Diagonal((1.0, 1.0, stretch_z, 1.0))
    _tag(bm, mat, lambda: bmesh.ops.create_icosphere(bm, subdivisions=subdivisions, radius=radius, matrix=matrix))


def add_torus(bm, major, minor, center, major_segments=128, minor_segments=4, mat=0):
    """Tore dans le plan XY, dessine dans un maillage existant (meme geometrie que dtx3d.torus_bmesh)."""

    def draw():
        grid = []
        for i in range(major_segments):
            a = 2 * math.pi * i / major_segments
            row = []
            for j in range(minor_segments):
                b = 2 * math.pi * j / minor_segments
                ring = major + minor * math.cos(b)
                row.append(bm.verts.new((center[0] + ring * math.cos(a), center[1] + ring * math.sin(a), center[2] + minor * math.sin(b))))
            grid.append(row)
        for i in range(major_segments):
            for j in range(minor_segments):
                i2, j2 = (i + 1) % major_segments, (j + 1) % minor_segments
                bm.faces.new((grid[i][j], grid[i2][j], grid[i2][j2], grid[i][j2]))

    _tag(bm, mat, draw)


def ribbon(bm, points, width, normal_of):
    """Ruban fin le long d'une polyligne (meridiens de la coupole) : 2 sommets par point."""
    rows = []
    for p in points:
        n = normal_of(p) * (width / 2)
        rows.append((bm.verts.new(p - n), bm.verts.new(p + n)))
    for (a, b), (c, d) in zip(rows, rows[1:]):
        bm.faces.new((a, b, d, c))


# --------------------------------------------------------------------------- scene
def build_plate(mats):
    parts = []
    plate = dtx3d.object_from_bmesh("Sonar_Plate", dtx3d.cylinder_bmesh(PLATE_R, PLATE_H, (0.0, 0.0, PLATE_H / 2), segments=96), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(dtx3d.object_from_bmesh("Sonar_Ground", dtx3d.cylinder_bmesh(PLATE_R - 0.12, 0.01, (0.0, 0.0, PLATE_H + 0.005), segments=96), [mats["ground"]]))

    for i, sector in enumerate(SECTORS):
        bm = bmesh.new()
        a0, a1 = phi_of(i) - STEP / 2 + GAP, phi_of(i) + STEP / 2 - GAP
        annular_sector(bm, R_MIN + 0.05, OUTER_R - 0.02, a0, a1, GROUND_TOP, 0.008, segments=16)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        ob = dtx3d.object_from_bmesh(f"Sonar_Sector_{i:02d}", bm, [mats["sector"]])
        ob["sector_index"], ob["sector"] = i, sector
        parts.append(ob)

    # Frontieres des secteurs.
    bm = bmesh.new()
    for i in range(len(SECTORS)):
        a = phi_of(i) - STEP / 2
        x, y, _ = bl(a, (R_MIN + OUTER_R) / 2, 0.0)
        add_box(bm, (OUTER_R - R_MIN, 0.008, 0.004), (x, y, GROUND_TOP + 0.012), rot_z=-a)
    parts.append(dtx3d.object_from_bmesh("Sonar_Spokes", bm, [mats["grid"]]))

    # Anneaux de confiance : plein (approuve), fin (connu), pointilles ambre (nouveau).
    z = GROUND_TOP + 0.014
    parts.append(dtx3d.object_from_bmesh("Sonar_Ring_Trusted", dtx3d.torus_bmesh(RING_TRUSTED, 0.012, (0.0, 0.0, z), 96, 4), [mats["trusted"]]))
    parts.append(dtx3d.object_from_bmesh("Sonar_Ring_Known", dtx3d.torus_bmesh(RING_KNOWN, 0.007, (0.0, 0.0, z), 112, 3), [mats["known"]]))
    bm = bmesh.new()
    dashes = 48
    for k in range(dashes):
        a0 = 2 * math.pi * k / dashes
        annular_sector(bm, RING_NEW - 0.018, RING_NEW + 0.018, a0, a0 + 0.55 * 2 * math.pi / dashes, GROUND_TOP + 0.008, 0.012, segments=2)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    parts.append(dtx3d.object_from_bmesh("Sonar_Ring_New", bm, [mats["new"]]))
    parts.append(dtx3d.object_from_bmesh("Sonar_Rim", dtx3d.torus_bmesh(OUTER_R + 0.14, 0.014, (0.0, 0.0, GROUND_TOP + 0.02), 112, 4), [mats["rim"]]))
    return parts


def build_gateway(mats):
    """La box : socle hexagonal, boitier, trois antennes, couronne lumineuse (MAT_SonarCore)."""
    base = dtx3d.object_from_bmesh("Sonar_GatewayBase", dtx3d.cylinder_bmesh(0.5, 0.08, (0.0, 0.0, GROUND_TOP + 0.04), segments=6), [mats["metal_light"]])
    dtx3d.add_bevel(base, 0.012)

    bm = bmesh.new()
    add_box(bm, (0.62, 0.4, 0.14), (0.0, 0.0, GROUND_TOP + 0.08 + 0.07))
    for x in (-0.22, 0.0, 0.22):
        add_cylinder(bm, 0.018, 0.42, (x, 0.14, GROUND_TOP + 0.15 + 0.21), segments=8)
        add_cylinder(bm, 0.03, 0.04, (x, 0.14, GROUND_TOP + 0.16), segments=8)
    for k in range(5):  # voyants en facade
        add_box(bm, (0.05, 0.012, 0.018), (-0.2 + 0.1 * k, -0.203, GROUND_TOP + 0.15), mat=1)
    gateway = dtx3d.object_from_bmesh("Sonar_Gateway", bm, [mats["metal"], mats["core"]])
    core = dtx3d.object_from_bmesh("Sonar_GatewayCore", dtx3d.torus_bmesh(0.42, 0.014, (0.0, 0.0, GROUND_TOP + 0.085), 6, 4), [mats["core"]])
    pulse = dtx3d.object_from_bmesh("Sonar_Pulse", dtx3d.torus_bmesh(1.0, 0.012, (0.0, 0.0, GROUND_TOP + 0.02), 96, 3), [mats["pulse"]])
    pulse.scale = (RING_TRUSTED * 0.9, RING_TRUSTED * 0.9, 1.0)  # position de repos (le web l'anime)
    return [base, gateway, core, pulse]


def build_dome(mats):
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=40, v_segments=20, radius=1.0)
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if v.co.z < -1e-4], context="VERTS")
    for v in bm.verts:
        v.co = Vector((v.co.x * DOME_R, v.co.y * DOME_R, GROUND_TOP + v.co.z * DOME_H))
    dome = dtx3d.object_from_bmesh("Sonar_Dome", bm, [mats["dome"]])
    dtx3d.smooth_by_angle(dome, 60)

    lines = bmesh.new()
    for t in (0.22, 0.5, 0.78):  # paralleles
        angle = t * math.pi / 2
        add_torus(lines, DOME_R * math.cos(angle), 0.006, (0.0, 0.0, GROUND_TOP + DOME_H * math.sin(angle)), 96, 3)
    for m in range(12):  # meridiens
        phi = 2 * math.pi * m / 12
        pts = []
        for k in range(25):
            t = (k / 24) * math.pi / 2 * 0.985
            pts.append(Vector(bl(phi, DOME_R * math.cos(t), GROUND_TOP + DOME_H * math.sin(t))))
        ribbon(lines, pts, 0.012, lambda p, phi=phi: Vector((math.sin(phi), math.cos(phi), 0.0)))
    return [dome, dtx3d.object_from_bmesh("Sonar_DomeLines", lines, [mats["dome_lines"]])]


def build_beam(mats):
    """Faisceau : lame verticale qui epouse la coupole (angle 0) + trainee au sol."""
    bm = bmesh.new()
    steps = 24
    rows = []
    for k in range(steps + 1):
        r = R_MIN + (OUTER_R - 0.05 - R_MIN) * k / steps
        rows.append((bm.verts.new(bl(0.0, r, GROUND_TOP + 0.02)), bm.verts.new(bl(0.0, r, dome_z(r) - 0.04))))
    for (a, b), (c, d) in zip(rows, rows[1:]):
        bm.faces.new((a, c, d, b)).material_index = 0
    annular_sector(bm, R_MIN + 0.05, OUTER_R - 0.05, -math.radians(22), 0.0, GROUND_TOP + 0.016, 0.002, segments=8, material_index=1)
    bm.normal_update()
    return [dtx3d.object_from_bmesh("Sonar_Beam", bm, [mats["beam"], mats["trail"]])]


# --------------------------------------------------------------------------- silhouettes
def glyphs(mats):
    """Une silhouette par type d'appareil, base a z = 0, face vers -Y (la camera).
    Materiau 0 = corps (MAT_GlyphBody), 1 = parties lumineuses (MAT_GlyphGlow, teinte cote web)."""
    s = GLYPH_SIZE
    G = 1  # indice du materiau lumineux

    def computer(bm):
        add_box(bm, (0.9 * s, 0.06 * s, 0.56 * s), (0.0, 0.0, 0.62 * s))  # ecran
        add_box(bm, (0.1 * s, 0.08 * s, 0.3 * s), (0.0, 0.03 * s, 0.17 * s))  # pied
        add_box(bm, (0.44 * s, 0.26 * s, 0.04 * s), (0.0, 0.03 * s, 0.02 * s))  # socle
        add_box(bm, (0.8 * s, 0.01 * s, 0.46 * s), (0.0, -0.032 * s, 0.62 * s), mat=G)

    def mobile(bm):
        add_box(bm, (0.42 * s, 0.07 * s, 0.86 * s), (0.0, 0.0, 0.47 * s))
        add_box(bm, (0.34 * s, 0.01 * s, 0.7 * s), (0.0, -0.037 * s, 0.49 * s), mat=G)
        add_box(bm, (0.36 * s, 0.28 * s, 0.04 * s), (0.0, 0.0, 0.02 * s))  # support

    def printer(bm):
        add_box(bm, (0.9 * s, 0.6 * s, 0.38 * s), (0.0, 0.0, 0.19 * s))
        add_box(bm, (0.6 * s, 0.3 * s, 0.025 * s), (0.0, 0.2 * s, 0.5 * s))  # bac papier
        add_box(bm, (0.56 * s, 0.01 * s, 0.035 * s), (0.0, -0.305 * s, 0.27 * s), mat=G)  # fente
        add_box(bm, (0.07 * s, 0.01 * s, 0.07 * s), (0.34 * s, -0.305 * s, 0.12 * s), mat=G)  # voyant

    def camera(bm):
        add_cylinder(bm, 0.05 * s, 0.5 * s, (0.0, 0.1 * s, 0.25 * s), segments=8)  # mat
        add_box(bm, (0.34 * s, 0.62 * s, 0.3 * s), (0.0, -0.05 * s, 0.62 * s))  # boitier
        add_cylinder(bm, 0.13 * s, 0.08 * s, (0.0, -0.38 * s, 0.62 * s), segments=16, axis="Y")
        add_cylinder(bm, 0.08 * s, 0.02 * s, (0.0, -0.43 * s, 0.62 * s), segments=16, axis="Y", mat=G)  # objectif

    def media(bm):
        add_box(bm, (1.25 * s, 0.05 * s, 0.68 * s), (0.0, 0.0, 0.5 * s))
        add_box(bm, (1.15 * s, 0.01 * s, 0.58 * s), (0.0, -0.027 * s, 0.5 * s), mat=G)
        for x in (-0.45 * s, 0.45 * s):
            add_box(bm, (0.05 * s, 0.24 * s, 0.16 * s), (x, 0.0, 0.08 * s))

    def nas(bm):
        add_box(bm, (0.5 * s, 0.6 * s, 0.86 * s), (0.0, 0.0, 0.43 * s))
        for k in range(3):
            add_box(bm, (0.36 * s, 0.01 * s, 0.04 * s), (0.0, -0.305 * s, (0.25 + 0.2 * k) * s), mat=G)

    def iot(bm):
        add_cylinder(bm, 0.2 * s, 0.2 * s, (0.0, 0.0, 0.1 * s), segments=6)  # culot hexagonal
        add_ico(bm, 0.26 * s, (0.0, 0.0, 0.42 * s), subdivisions=2, mat=G)  # ampoule

    def unknown(bm):
        add_ico(bm, 0.3 * s, (0.0, 0.0, 0.55 * s), subdivisions=0, stretch_z=1.45, mat=G)  # cristal
        add_cylinder(bm, 0.16 * s, 0.05 * s, (0.0, 0.0, 0.025 * s), segments=6)

    makers = {"computer": computer, "mobile": mobile, "printer": printer, "camera": camera, "media": media, "nas": nas, "iot": iot, "unknown": unknown}
    out = []
    for kind in GLYPH_KINDS:
        bm = bmesh.new()
        makers[kind](bm)
        ob = dtx3d.object_from_bmesh(f"Glyph_{kind}", bm, [mats["glyph_body"], mats["glyph_glow"]])
        ob["kind"] = kind
        dtx3d.add_bevel(ob, 0.006, segments=1)
        out.append(ob)
    out.append(dtx3d.object_from_bmesh("Glyph_Echo", dtx3d.torus_bmesh(0.3, 0.014, (0.0, 0.0, 0.0), 40, 3), [mats["echo"]]))
    stalk = bmesh.new()
    add_cylinder(stalk, 0.012, 1.0, (0.0, 0.0, 0.5), segments=8)  # hauteur 1 : le web l'etire
    out.append(dtx3d.object_from_bmesh("Glyph_Stalk", stalk, [mats["stalk"]]))
    return out


def library(glyph_objects):
    root = dtx3d.link(bpy.data.objects.new("Glyph_Library", None))
    for ob in glyph_objects:
        ob.parent = root
        ob.hide_render = True  # bibliotheque : invisible dans les rendus, presente dans le glb
    return root


# --------------------------------------------------------------------------- demonstration (rendus seulement)
DEMO = (  # (type, secteur, anneau, decalage angulaire en fraction de secteur, hauteur du mat)
    ("computer", 0, RING_TRUSTED, -0.15, 0.25),
    ("nas", 0, RING_KNOWN, 0.2, 0.55),
    ("mobile", 1, RING_TRUSTED, 0.15, 0.0),
    ("mobile", 1, RING_KNOWN, -0.2, 0.0),
    ("media", 2, RING_KNOWN, -0.15, 0.2),
    ("printer", 2, RING_TRUSTED, 0.2, 0.35),
    ("camera", 2, RING_NEW, 0.25, 0.3),
    ("iot", 3, RING_KNOWN, 0.0, 0.15),
    ("unknown", 4, RING_NEW, -0.1, 0.7),
)


def demo_echoes(mats, glyph_objects):
    by_name = {ob.name: ob for ob in glyph_objects}
    echo_new = dtx3d.make_material("MAT_DemoEchoNew", "#000000", roughness=0.4, emission=AMBER, strength=1.6, alpha=0.9)
    glow_new = dtx3d.make_material("MAT_DemoGlowNew", "#000000", roughness=0.35, emission=AMBER, strength=2.4)
    for n, (kind, sector, ring, offset, stalk) in enumerate(DEMO):
        phi = phi_of(sector) + offset * STEP
        x, y, _ = bl(phi, ring, 0.0)
        is_new = ring == RING_NEW
        glyph = by_name[f"Glyph_{kind}"].copy()
        glyph.data = glyph.data.copy()
        if is_new:
            glyph.data.materials[1] = glow_new
        lift = min(GROUND_TOP + 0.02 + stalk * 0.6, dome_z(ring) - GLYPH_SIZE - 0.05)  # meme plafond que le web
        glyph.location = (x, y, lift)
        glyph.hide_render = False
        glyph.name = f"Demo_{n}_{kind}"
        dtx3d.link(glyph)
        echo = by_name["Glyph_Echo"].copy()
        echo.name, echo.location, echo.hide_render = f"Demo_{n}_echo", (x, y, GROUND_TOP + 0.016), False
        if is_new:
            echo.data = echo.data.copy()
            echo.data.materials[0] = echo_new
        dtx3d.link(echo)
        if stalk > 0:
            mast = by_name["Glyph_Stalk"].copy()
            mast.name, mast.location, mast.hide_render = f"Demo_{n}_stalk", (x, y, GROUND_TOP + 0.016), False
            mast.scale = (1.0, 1.0, lift - GROUND_TOP - 0.016)
            dtx3d.link(mast)
    beam = bpy.data.objects["Sonar_Beam"]
    beam.rotation_euler.z = math.pi / 3  # faisceau a l'arriere droit (phi three = -60 deg) : ne masque pas la scene
    pulse = bpy.data.objects["Sonar_Pulse"]
    pulse.scale = (RING_KNOWN * 1.12, RING_KNOWN * 1.12, 1.0)


def main():
    scene = dtx3d.reset_scene()
    mats = build_materials()
    parts = build_plate(mats) + build_gateway(mats) + build_dome(mats) + build_beam(mats)
    glyph_objects = glyphs(mats)
    root = dtx3d.root_empty("Sonar_Widget", parts)
    library(glyph_objects).parent = root

    src, web = dtx3d.paths(__file__)
    print(f"[sonar] triangles (modificateurs appliques) : {dtx3d.count_triangles(parts + glyph_objects)}")
    dtx3d.export_glb(os.path.join(web, "sonar.glb"))  # AVANT la demonstration : le glb n'en contient rien

    demo_echoes(mats, glyph_objects)
    dtx3d.camera_persp(scene, location=(0.0, -9.0, 6.4), target=(0.0, 0.0, 0.45), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.4), scale=1.8)
    bpy.context.preferences.filepaths.save_version = 0
    bpy.ops.wm.save_as_mainfile(filepath=os.path.join(src, "sonar.blend"))
    dtx3d.render(scene, os.path.join(src, "sonar_preview.png"), (1400, 800))
    dtx3d.render(scene, os.path.join(web, "sonar_poster.png"), (1000, 570), transparent=True)
    print(f"[sonar] termine -> {src} + {web}")


if __name__ == "__main__":
    main()
