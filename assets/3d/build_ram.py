"""
build_ram.py - Barrette memoire 3D (page Systeme de DeTecTX).

Une barrette DIMM dressee dans son slot : circuit, 8 puces, contacts dores, marquage.
Le web allume les puces de gauche a droite selon l'occupation de la RAM.

Usage : blender --background --python assets/3d/build_ram.py

Contrat avec le composant web (frontend/src/components/three/ram-module.tsx) :
    RAM_Widget (racine), RAM_Chip_0..7 (userData.chip_index, MAT_RamChip).
"""

import os
import sys

sys.dont_write_bytecode = True  # pas de __pycache__ dans assets/3d
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import dtx3d  # noqa: E402

CHIPS = 8
BOARD_W, BOARD_T, BOARD_H = 2.7, 0.04, 0.64
SLOT_H = 0.14
BOARD_Z = SLOT_H + BOARD_H / 2  # la barrette est enfoncee dans le slot


def build_materials() -> dict:
    mats = dtx3d.base_materials()
    mats["pcb"] = dtx3d.make_material("MAT_Pcb", "#06120e", roughness=0.5)
    mats["chip"] = dtx3d.make_material("MAT_RamChip", "#0b0f14", metallic=0.2, roughness=0.3, emission=dtx3d.ACCENT, strength=0.6)
    mats["gold"] = dtx3d.make_material("MAT_Gold", "#b08d57", metallic=1.0, roughness=0.3)
    mats["label"] = dtx3d.make_material("MAT_RamLabel", "#000000", roughness=0.4, emission="#8a97a9", strength=0.8)
    return mats


def build(mats):
    parts = []
    slot = dtx3d.object_from_bmesh("RAM_Slot", dtx3d.box_bmesh((BOARD_W + 0.2, 0.24, SLOT_H), (0.0, 0.0, SLOT_H / 2)), [mats["metal"]])
    dtx3d.add_bevel(slot, 0.015)
    parts.append(slot)
    for side in (-1, 1):  # loquets aux extremites
        latch = dtx3d.object_from_bmesh(
            f"RAM_Latch_{'L' if side < 0 else 'R'}",
            dtx3d.box_bmesh((0.08, 0.28, 0.32), (side * (BOARD_W / 2 + 0.12), 0.0, 0.16)),
            [mats["metal_light"]],
        )
        dtx3d.add_bevel(latch, 0.01)
        parts.append(latch)

    board = dtx3d.object_from_bmesh("RAM_Board", dtx3d.box_bmesh((BOARD_W, BOARD_T, BOARD_H), (0.0, 0.0, BOARD_Z)), [mats["pcb"]])
    dtx3d.add_bevel(board, 0.008)
    parts.append(board)

    # Contacts dores juste au-dessus du slot (face avant, vers la camera = -Y).
    pads = dtx3d.object_from_bmesh(
        "RAM_Pads", dtx3d.box_bmesh((0.045, 0.004, 0.07), (-1.2, -BOARD_T / 2 - 0.002, SLOT_H + 0.05)), [mats["gold"]]
    )
    arr = pads.modifiers.new("Array", "ARRAY")
    arr.count = 35
    arr.use_relative_offset = False
    arr.use_constant_offset = True
    arr.constant_offset_displace = (2.4 / 34, 0.0, 0.0)
    parts.append(pads)

    # 8 puces memoire, indexees de gauche a droite.
    pitch = 0.3
    for i in range(CHIPS):
        x = (i - (CHIPS - 1) / 2) * pitch
        chip = dtx3d.object_from_bmesh(
            f"RAM_Chip_{i}", dtx3d.box_bmesh((0.26, 0.02, 0.22), (x, -BOARD_T / 2 - 0.01, BOARD_Z + 0.03)), [mats["chip"]]
        )
        chip["chip_index"] = i  # glTF extras -> userData.chip_index
        parts.append(chip)

    parts.append(
        dtx3d.text_mesh("RAM_Label", "DDR5 · DeTecTX", 0.055, (-0.95, -BOARD_T / 2 - 0.001, BOARD_Z + BOARD_H / 2 - 0.07), mats["label"])
    )
    # Le texte est cree a plat (XY) : on le dresse face a la camera.
    parts[-1].rotation_euler.x = 1.5708
    return parts


def main():
    scene = dtx3d.reset_scene()
    parts = build(build_materials())
    dtx3d.root_empty("RAM_Widget", parts)
    dtx3d.camera_persp(scene, location=(0.0, -4.4, 2.0), target=(0.0, 0.0, 0.42), lens=45)
    dtx3d.studio(scene, target=(0.0, 0.0, 0.4), scale=1.3)
    dtx3d.finish("ram", __file__, scene, parts, preview_res=(1200, 600), poster_res=(900, 450))


if __name__ == "__main__":
    main()
