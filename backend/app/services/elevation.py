"""Lancement d'un assistant DeTecTX avec élévation (invite UAC de Windows).

Le backend reste SANS droits administrateur : chaque action privilégiée (pare-feu, remèdes)
passe par un script autonome lancé via `ShellExecuteEx(runas)`. L'utilisateur confirme dans une
boîte de dialogue du système, hors de portée d'une page web.

L'interpréteur est lancé avec -E (variables PYTHON* ignorées) pour ne pas hériter d'un
PYTHONPATH piégé dans le processus élevé.
"""

import subprocess
import sys
from pathlib import Path

TIMEOUT_S = 120  # le temps de lire et d'accepter l'invite UAC
_ERROR_CANCELLED = 1223  # l'utilisateur a refusé l'invite UAC


class ActionError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


def is_admin() -> bool:
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


def run_elevated(helper: Path, args: list[str], *, nothing_changed: str, timeout: int = TIMEOUT_S) -> int:
    """Lance `helper` avec élévation et renvoie son code de sortie."""
    if sys.platform != "win32":
        raise ActionError(501, "Action disponible uniquement sous Windows.")
    command = [sys.executable, "-E", str(helper), *args]
    if is_admin():  # backend déjà élevé : pas d'invite
        return subprocess.run(command, timeout=timeout, capture_output=True, check=False).returncode

    import pywintypes
    import win32con
    import win32event
    import win32process
    from win32com.shell import shell, shellcon

    try:
        info = shell.ShellExecuteEx(
            fMask=shellcon.SEE_MASK_NOCLOSEPROCESS | shellcon.SEE_MASK_NO_CONSOLE,
            lpVerb="runas",
            lpFile=command[0],
            lpParameters=subprocess.list2cmdline(command[1:]),
            nShow=win32con.SW_HIDE,
        )
    except pywintypes.error as e:
        if e.winerror == _ERROR_CANCELLED:
            raise ActionError(403, f"Autorisation refusée dans l'invite Windows : {nothing_changed}") from e
        raise ActionError(500, f"Lancement de l'assistant impossible ({e.winerror}).") from e
    handle = info["hProcess"]
    try:
        if win32event.WaitForSingleObject(handle, timeout * 1000) != win32event.WAIT_OBJECT_0:
            raise ActionError(504, "Pas de réponse à l'invite Windows dans le délai : action abandonnée.")
        return win32process.GetExitCodeProcess(handle)
    finally:
        handle.Close()
