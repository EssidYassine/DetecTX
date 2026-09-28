"""
build_radar.py - « Radar des menaces » de la page Alertes DeTecTX.

Au centre le poste surveille. Autour, 15 secteurs : les 14 tactiques ATT&CK dans l'ordre de
la kill chain (de l'avant-gauche, par l'arriere, jusqu'a l'avant-droit) puis « Non classe ».
Les anneaux mesurent l'anciennete : plus un dossier d'alertes est proche du centre, plus sa
derniere occurrence est recente (1 h, 24 h, 7 j, 30 j). Le web y dresse un cristal par
dossier (hauteur = risque) et fait tourner le balayage.

Usage : blender --background --python assets/3d/build_radar.py

Contrat avec le composant web (frontend/src/components/three/threat-radar.tsx) :
    Radar_Widget (racine), Sector_00..14 (userData.sector_index, MAT_Sector clone par secteur),
    SectorMark_00..14 (MAT_SectorMark, liseré exterieur teinte selon l'activite),
    Radar_Sweep (balayage, tourne autour de l'axe vertical), MAT_RadarRim (bord, teinte posture),
    MAT_RadarCore (le poste).
    Constantes ci-dessous (GROUND_TOP, R_MIN, OUTER_R, RING_R, SECTORS, START) : reprises
    telles quelles par le composant.

Reperes : angle phi mesure dans le repere three.js (x = cos phi, z = sin phi, +Z vers la
camera). Blender -> three : (x, y, z) -> (x, z, -y), donc un point three (r, phi) est en
Blender (r cos phi, -r sin phi).
"""

import math
import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

PLATE_R, PLATE_H = 3.35, 0.1
GROUND_TOP = 0.11
R_MIN = 0.62  # bord de la zone du poste
OUTER_R = 3.0
RING_R = (1.2, 1.8, 2.4, 3.0)  # 1 h, 24 h, 7 j, 30 j
SECTORS = 15
STEP = 2 * math.pi / SECTORS
START = math.pi / 2  # secteur 0 juste a gauche de l'avant, puis sens croissant (gauche -> arriere -> droite)
GAP = 0.012  # demi-ecart angulaire entre secteurs (rad)


def phi_of(i: float) -> float:
    return START + STEP * (i + 0.5)


def bl(phi: float, r: float, z: float) -> tuple:
    """Point du repere three (rayon, angle phi, hauteur) -> coordonnees Blender."""
    return (r * math.cos(phi), -r * math.sin(phi), z)


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_RadarGround", "#060d0c", roughness=0.85)
    mats["sector"] = dtx3d.make_material("MAT_Sector", "#0b1d1a", roughness=0.7, emission=dtx3d.ACCENT, strength=0.0)
    mats["mark"] = dtx3d.make_material("MAT_SectorMark", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=0.8)
    mats["ring"] = dtx3d.make_material("MAT_RadarRing", "#000000", roughness=0.4, emission="#8a97a9", strength=0.35)
    mats["grid"] = dtx3d.make_material("MAT_RadarGrid", "#000000", roughness=0.4, emission="#8a97a9", strength=0.12)
    mats["rim"] = dtx3d.make_material("MAT_RadarRim", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=2.2)
    mats["core"] = dtx3d.make_material("MAT_RadarCore", "#000000", roughness=0.3, emission=dtx3d.ACCENT, strength=2.8)
    mats["sweep_head"] = dtx3d.make_material("MAT_SweepHead", "#2dd4bf", roughness=0.2, emission=dtx3d.ACCENT, strength=0.9, alpha=0.32)
    mats["sweep_mid"] = dtx3d.make_material("MAT_SweepMid", "#2dd4bf", roughness=0.2, emission=dtx3d.ACCENT, strength=0.5, alpha=0.14)
    mats["sweep_tail"] = dtx3d.make_material("MAT_SweepTail", "#2dd4bf", roughness=0.2, emission=dtx3d.ACCENT, strength=0.3, alpha=0.06)
    return mats


def annular_sector(bm, r0, r1, a0, a1, z0, h, segments=10, material_index=0):
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
        faces += [
            bm.faces.new((ti, to, to2, ti2)),  # dessus
            bm.faces.new((bi2, bo2, bo, bi)),  # dessous
            bm.faces.new((to, bo, bo2, to2)),  # bord exterieur
            bm.faces.new((ti2, bi2, bi, ti)),  # bord interieur
        ]
    for (ti, to), (bi, bo) in ((top[0], bottom[0]), (top[-1], bottom[-1])):
        faces.append(bm.faces.new((ti, bi, bo, to)))
    for f in faces:
        f.material_index = material_index
    return faces


def build(mats):
    parts = []
    plate = dtx3d.object_from_bmesh("Radar_Plate", dtx3d.cylinder_bmesh(PLATE_R, PLATE_H, (0.0, 0.0, PLATE_H / 2), segments=120), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    parts.append(plate)
    parts.append(dtx3d.object_from_bmesh("Radar_Ground", dtx3d.cylinder_bmesh(PLATE_R - 0.12, 0.01, (0.0, 0.0, PLATE_H + 0.005), segments=120), [mats["ground"]]))

    # Secteurs (un objet par tactique, indexe pour le web) + liseré exterieur.
    for i in range(SECTORS):
        a0, a1 = phi_of(i) - STEP / 2 + GAP, phi_of(i) + STEP / 2 - GAP
        bm = bmesh.new()
        annular_sector(bm, R_MIN + 0.04, OUTER_R - 0.02, a0, a1, GROUND_TOP, 0.008)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        sector = dtx3d.object_from_bmesh(f"Sector_{i:02d}", bm, [mats["sector"]])
        sector["sector_index"] = i
        bm = bmesh.new()
        annular_sector(bm, OUTER_R + 0.04, OUTER_R + 0.1, a0 + 0.02, a1 - 0.02, GROUND_TOP, 0.02)
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        mark = dtx3d.object_from_bmesh(f"SectorMark_{i:02d}", bm, [mats["mark"]])
        mark["sector_index"] = i
        parts += [sector, mark]

    # Anneaux d'anciennete + bord du radar (liseré posture).
    for k, r in enumerate(RING_R[:-1]):
        parts.append(dtx3d.object_from_bmesh(f"Radar_Ring_{k}", dtx3d.torus_bmesh(r, 0.006, (0.0, 0.0, GROUND_TOP + 0.012), 128, 4), [mats["ring"]]))
    parts.append(dtx3d.object_from_bmesh("Radar_Rim", dtx3d.torus_bmesh(OUTER_R + 0.16, 0.016, (0.0, 0.0, GROUND_TOP + 0.02), 160, 6), [mats["rim"]]))
    parts.append(dtx3d.object_from_bmesh("Radar_CoreRing", dtx3d.torus_bmesh(R_MIN, 0.01, (0.0, 0.0, GROUND_TOP + 0.012), 96, 4), [mats["ring"]]))

    # Rayons : frontieres des secteurs.
    bm = bmesh.new()
    for i in range(SECTORS):
        a = phi_of(i) - STEP / 2
        mid = (R_MIN + OUTER_R) / 2
        x, y, _ = bl(a, mid, 0.0)
        bmesh.ops.create_cube(
            bm,
            size=1.0,
            matrix=Matrix.Translation(Vector((x, y, GROUND_TOP + 0.012))) @ Matrix.Rotation(-a, 4, "Z") @ Matrix.Diagonal((OUTER_R - R_MIN, 0.006, 0.004, 1.0)),
        )
    parts.append(dtx3d.object_from_bmesh("Radar_Spokes", bm, [mats["grid"]]))

    # Le poste : socle hexagonal, monolithe, couronne lumineuse.
    base = dtx3d.object_from_bmesh("Radar_HostBase", dtx3d.cylinder_bmesh(0.44, 0.1, (0.0, 0.0, GROUND_TOP + 0.05), segments=6), [mats["metal_light"]])
    dtx3d.add_bevel(base, 0.012)
    parts.append(base)
    parts.append(dtx3d.object_from_bmesh("Radar_HostGlow", dtx3d.torus_bmesh(0.36, 0.012, (0.0, 0.0, GROUND_TOP + 0.105), 6, 4), [mats["core"]]))
    tower = dtx3d.object_from_bmesh("Radar_Host", dtx3d.box_bmesh((0.2, 0.2, 0.46), (0.0, 0.0, GROUND_TOP + 0.1 + 0.23)), [mats["metal"]])
    dtx3d.add_bevel(tower, 0.015)
    parts.append(tower)
    parts.append(dtx3d.object_from_bmesh("Radar_HostTop", dtx3d.box_bmesh((0.16, 0.16, 0.025), (0.0, 0.0, GROUND_TOP + 0.575)), [mats["core"]]))

    # Balayage : trois portions d'anneau de transparence decroissante (tete, milieu, trainee).
    bm = bmesh.new()
    lead = 0.0
    for index, width in enumerate((math.radians(6), math.radians(16), math.radians(34))):
        annular_sector(bm, R_MIN + 0.06, OUTER_R - 0.04, lead - width, lead, GROUND_TOP + 0.016, 0.002, segments=6, material_index=index)
        lead -= width
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    parts.append(dtx3d.object_from_bmesh("Radar_Sweep", bm, [mats["sweep_head"], mats["sweep_mid"], mats["sweep_tail"]]))
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Radar_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -8.4, 6.8), target=(0.0, 0.0, 0.1), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=1.8)
    dtx3d.finish("radar", __file__, scene, parts, preview_res=(1400, 800), poster_res=(1000, 570))


if __name__ == "__main__":
    main()
