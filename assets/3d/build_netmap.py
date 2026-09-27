"""
build_netmap.py - Constellation reseau 3D (page Systeme de DeTecTX, vue Reseau).

Plateau circulaire : au centre le poste (moyeu hexagonal + coeur lumineux), autour trois
anneaux : ports en ecoute (proche du moyeu), reseau local (LAN), Internet. Le web y place un
noeud par IP distante et trace les connexions du coeur vers chaque noeud.

Usage : blender --background --python assets/3d/build_netmap.py

Contrat avec le composant web (frontend/src/components/three/network-map.tsx) :
    Net_Widget (racine), Net_Core (MAT_HubCore, pulse avec l'activite reseau).
    RING_PORTS / RING_LAN / RING_WAN / GROUND_TOP / CORE_Z ci-dessous : repris par le composant.
"""

import math
import os
import sys

import bmesh
from mathutils import Matrix, Vector

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

PLATE_R, PLATE_H = 3.4, 0.1
GROUND_TOP = 0.11
RING_PORTS, RING_LAN, RING_WAN = 0.72, 1.5, 2.75
CORE_Z = 0.62


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["ground"] = dtx3d.make_material("MAT_NetGround", "#07120f", roughness=0.85)
    mats["core"] = dtx3d.make_material("MAT_HubCore", "#000000", roughness=0.3, emission=dtx3d.ACCENT, strength=3.0)
    mats["wan"] = dtx3d.make_material("MAT_NetRingWan", "#000000", roughness=0.4, emission=dtx3d.ACCENT, strength=1.2)
    mats["lan"] = dtx3d.make_material("MAT_NetRingLan", "#000000", roughness=0.4, emission=dtx3d.CYAN, strength=0.7)
    mats["ports"] = dtx3d.make_material("MAT_PortRing", "#000000", roughness=0.4, emission="#8a97a9", strength=0.35)
    mats["grid"] = dtx3d.make_material("MAT_NetGrid", "#000000", roughness=0.4, emission="#8a97a9", strength=0.12)
    return mats


def build(mats):
    plate = dtx3d.object_from_bmesh("Net_Plate", dtx3d.cylinder_bmesh(PLATE_R, PLATE_H, (0.0, 0.0, PLATE_H / 2), segments=96), [mats["metal"]])
    dtx3d.add_bevel(plate, 0.02)
    dtx3d.smooth_by_angle(plate)
    ground = dtx3d.object_from_bmesh(
        "Net_Ground", dtx3d.cylinder_bmesh(PLATE_R - 0.15, 0.01, (0.0, 0.0, PLATE_H + 0.005), segments=96), [mats["ground"]]
    )

    rings = [
        dtx3d.object_from_bmesh("Net_RingWan", dtx3d.torus_bmesh(RING_WAN, 0.014, (0.0, 0.0, GROUND_TOP), 128, 6), [mats["wan"]]),
        dtx3d.object_from_bmesh("Net_RingLan", dtx3d.torus_bmesh(RING_LAN, 0.012, (0.0, 0.0, GROUND_TOP), 96, 6), [mats["lan"]]),
        dtx3d.object_from_bmesh("Net_RingPorts", dtx3d.torus_bmesh(RING_PORTS, 0.008, (0.0, 0.0, GROUND_TOP), 64, 4), [mats["ports"]]),
    ]

    # Rayons discrets (lecture des directions), un seul maillage.
    bm = bmesh.new()
    spokes = 24
    inner, outer = 0.95, PLATE_R - 0.25
    for i in range(spokes):
        angle = 2 * math.pi * i / spokes
        mid = (inner + outer) / 2
        mat = (
            Matrix.Translation(Vector((math.cos(angle) * mid, math.sin(angle) * mid, GROUND_TOP)))
            @ Matrix.Rotation(angle, 4, "Z")
            @ Matrix.Diagonal((outer - inner, 0.008, 0.004, 1.0))
        )
        bmesh.ops.create_cube(bm, size=1.0, matrix=mat)
    grid = dtx3d.object_from_bmesh("Net_Grid", bm, [mats["grid"]])

    # Moyeu : le poste surveille.
    hub = dtx3d.object_from_bmesh("Net_Hub", dtx3d.cylinder_bmesh(0.4, 0.28, (0.0, 0.0, GROUND_TOP + 0.14), segments=6), [mats["metal_light"]])
    dtx3d.add_bevel(hub, 0.02)
    collar = dtx3d.object_from_bmesh("Net_Collar", dtx3d.torus_bmesh(0.3, 0.02, (0.0, 0.0, GROUND_TOP + 0.3), 48, 6), [mats["core"]])
    core = dtx3d.object_from_bmesh("Net_Core", dtx3d.icosphere_bmesh(0.2, (0.0, 0.0, CORE_Z), subdivisions=2), [mats["core"]])
    return [plate, ground, *rings, grid, hub, collar, core]


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("Net_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -8.4, 6.6), target=(0.0, 0.0, 0.0), lens=35)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.2), scale=1.8)
    dtx3d.finish("netmap", __file__, scene, parts, preview_res=(1400, 800), poster_res=(1000, 570))


if __name__ == "__main__":
    main()
