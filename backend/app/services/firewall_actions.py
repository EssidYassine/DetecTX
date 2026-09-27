"""Actions sur le pare-feu Windows (phase B) : bloquer un port, retirer un blocage DeTecTX.

Le backend reste SANS droits administrateur. Chaque action lance l'assistant fw_helper.py
avec élévation : Windows affiche son invite UAC et l'utilisateur confirme (ou refuse) dans une
boîte de dialogue système. Le résultat n'est pas cru sur parole : on relit le pare-feu pour
vérifier que la règle existe (ou a disparu).

Garanties :
- seules des règles « Bloquer » du groupe DeTecTX sont créées ; aucune règle existante n'est
  modifiée ou supprimée (l'assistant refuse de retirer une règle hors du groupe) ;
- une seule action à la fois ; arguments validés ici ET dans l'assistant ;
- l'interpréteur est lancé avec -E (variables PYTHON* ignorées) pour ne pas hériter d'un
  PYTHONPATH piégé dans le processus élevé.
"""

import subprocess
import sys
import threading
from pathlib import Path

from app.services import firewall, fw_helper

HELPER = Path(fw_helper.__file__).resolve()
TIMEOUT_S = 120  # le temps de lire et d'accepter l'invite UAC
_ERROR_CANCELLED = 1223  # l'utilisateur a refusé l'invite UAC
_lock = threading.Lock()


class ActionError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


def _run_elevated(args: list[str]) -> int:
    """Lance l'assistant avec élévation et renvoie son code de sortie."""
    if sys.platform != "win32":
        raise ActionError(501, "Pilotage du pare-feu disponible uniquement sous Windows.")
    command = [sys.executable, "-E", str(HELPER), *args]
    if fw_helper.is_admin():  # backend déjà élevé : pas d'invite
        return subprocess.run(command, timeout=TIMEOUT_S, capture_output=True, check=False).returncode

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
            raise ActionError(403, "Autorisation refusée dans l'invite Windows : aucune règle modifiée.") from e
        raise ActionError(500, f"Lancement de l'assistant impossible ({e.winerror}).") from e
    handle = info["hProcess"]
    try:
        if win32event.WaitForSingleObject(handle, TIMEOUT_S * 1000) != win32event.WAIT_OBJECT_0:
            raise ActionError(504, "Pas de réponse à l'invite Windows dans le délai : action abandonnée.")
        return win32process.GetExitCodeProcess(handle)
    finally:
        handle.Close()


def _check_exit(code: int) -> None:
    if code == fw_helper.EXIT_OK:
        return
    messages = {
        fw_helper.EXIT_ARGS: (400, "Demande refusée par l'assistant pare-feu (paramètres invalides)."),
        fw_helper.EXIT_FIREWALL: (502, "Le pare-feu Windows a refusé la modification."),
        fw_helper.EXIT_NOT_ADMIN: (403, "L'assistant n'a pas obtenu les droits administrateur."),
    }
    status, detail = messages.get(code, (500, f"Assistant pare-feu : code de sortie inattendu {code}."))
    raise ActionError(status, detail)


def _detectx_rule_names() -> set[str]:
    state, _ = firewall.read_state(force=True)  # relecture réelle, pas le cache
    return {r.name for r in state.rules if r.group == fw_helper.GROUP}


def _exclusive(action):
    if not _lock.acquire(blocking=False):
        raise ActionError(409, "Une action sur le pare-feu est déjà en cours.")
    try:
        return action()
    finally:
        _lock.release()


def block(targets: list[tuple[str, int]], profiles: list[str]) -> dict:
    """Bloque l'entrant sur plusieurs ports (TCP et UDP mêlés) : une seule invite UAC."""
    try:
        targets = fw_helper.parse_targets(fw_helper.format_targets(targets))
        profiles = fw_helper.parse_profiles(",".join(profiles))
    except fw_helper.Refused as e:
        raise ActionError(400, f"Demande invalide : {e}.") from e
    names = [fw_helper.rule_name(proto, port, profiles) for proto, port in targets]

    def run() -> dict:
        _check_exit(_run_elevated(["block", "--targets", fw_helper.format_targets(targets), "--profiles", ",".join(profiles)]))
        present = _detectx_rule_names()
        missing = [n for n in names if n not in present]
        if missing:
            raise ActionError(502, f"Règle(s) absente(s) après l'opération : {', '.join(missing)}.")
        return {"ok": True, "rules": names}

    return _exclusive(run)


def unblock(name: str) -> dict:
    if not fw_helper.NAME_RE.match(name):
        raise ActionError(400, "Nom de règle non conforme au format DeTecTX.")

    def run() -> dict:
        _check_exit(_run_elevated(["unblock", "--name", name]))
        if name in _detectx_rule_names():
            raise ActionError(502, "La règle est toujours présente après l'opération.")
        return {"ok": True, "rules": [name]}

    return _exclusive(run)


def elevated() -> bool:
    return sys.platform == "win32" and fw_helper.is_admin()
