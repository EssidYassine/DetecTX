"""Catégorie du réseau connecté (Public <-> Privé), changée par l'administrateur via l'invite UAC.

Pourquoi : Windows classe souvent un nouveau Wi-Fi en « Public », même à la maison ; DeTecTX
refuse alors tout scan actif (garde-fou légal). Ce bouton évite d'aller chercher le réglage
dans Windows. Il a un coût de sécurité : en « Privé », le pare-feu autorise davantage (partage,
découverte) — l'interface le dit avant d'agir, et le retour en « Public » est à un clic.

Même modèle que firewall_actions : backend sans droits, assistant autonome élevé
(netprofile_helper.py) qui revalide tout, une seule action à la fois, et résultat RELU auprès de
Windows au lieu d'être cru sur parole.
"""

import threading
from pathlib import Path

from app.services import elevation, firewall, netprofile_helper
from app.services.elevation import ActionError

HELPER = Path(netprofile_helper.__file__).resolve()
_lock = threading.Lock()

__all__ = ["ActionError", "set_category"]


def _check_exit(code: int) -> None:
    if code == netprofile_helper.EXIT_OK:
        return
    messages = {
        netprofile_helper.EXIT_ARGS: (400, "Demande refusée par l'assistant (réseau de domaine ou paramètres invalides)."),
        netprofile_helper.EXIT_NOT_FOUND: (409, "Réseau introuvable ou ambigu : changez la catégorie dans les paramètres Windows."),
        netprofile_helper.EXIT_NOT_ADMIN: (403, "L'assistant n'a pas obtenu les droits administrateur."),
        netprofile_helper.EXIT_WINDOWS: (502, "Windows a refusé le changement de catégorie."),
    }
    status, detail = messages.get(code, (500, f"Assistant réseau : code de sortie inattendu {code}."))
    raise ActionError(status, detail)


def current_category(name: str) -> str | None:
    """Catégorie actuelle du réseau connecté portant ce nom (relecture réelle)."""
    found = [n["category"] for n in firewall.connected_networks() if n.get("name") == name]
    return found[0] if len(found) == 1 else None


def set_category(name: str, category: str) -> dict:
    """Passe le réseau `name` en `category` (« private » | « public »). Bloquant : attend l'invite UAC."""
    try:
        netprofile_helper.check_name(name)
        netprofile_helper.check_category(category)
    except netprofile_helper.Refused as e:
        raise ActionError(400, f"Demande invalide : {e}.") from e
    if not _lock.acquire(blocking=False):
        raise ActionError(409, "Un changement de catégorie est déjà en cours.")
    try:
        before = current_category(name)
        if before is None:
            raise ActionError(409, "Réseau introuvable ou ambigu : changez la catégorie dans les paramètres Windows.")
        if before == "domain":
            raise ActionError(400, "Réseau de domaine (géré par une entreprise) : DeTecTX n'y touche pas.")
        if before == category:
            return {"ok": True, "already": True, "name": name, "category": category}
        _check_exit(elevation.run_elevated(HELPER, ["set", "--name", name, "--category", category], nothing_changed="catégorie inchangée."))
        after = current_category(name)
        if after != category:
            raise ActionError(502, f"Windows indique toujours « {after or 'inconnue'} » après l'opération.")
        return {"ok": True, "already": False, "name": name, "category": category}
    finally:
        _lock.release()
