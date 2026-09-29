"""Remèdes : corriger d'un clic ce qui rend le poste « malsain », et pouvoir revenir en arrière.

Chaque remède suit le même cycle :
  1. lire l'état ACTUEL (sans droits admin) et le garder dans le journal des remèdes ;
  2. lancer `remedy_helper.py` avec élévation (invite UAC de Windows) — sauf pour une entrée de
     démarrage de l'utilisateur (HKCU), modifiable sans droits, comme le Gestionnaire des tâches ;
  3. RELIRE l'état pour vérifier : le code de retour de l'assistant n'est pas cru sur parole ;
  4. proposer l'annulation (valeur précédente restaurée) quand c'est possible.

Garde-fous (en plus de ceux de l'assistant, qui revalide tout) : catalogue fermé, une action à
la fois, jamais une tâche ou un service signé Microsoft, identifiants de persistance acceptés
UNIQUEMENT s'ils figurent dans l'inventaire courant (jamais un chemin fourni par le client).
"""

from __future__ import annotations

import json
import logging
import os
import sys
import tempfile
import threading
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from app.services import authenticode, elevation, hardening, persistence
from app.services import remedy_helper as helper
from app.services.elevation import ActionError

log = logging.getLogger("detectx.remedies")

HELPER = Path(helper.__file__).resolve()
JOURNAL = Path("data/remedies.json")
MAX_JOURNAL = 200
_lock = threading.Lock()


@dataclass(frozen=True)
class Meta:
    title: str
    change: str  # ce qui est modifié, exactement
    reboot: bool = False
    revertible: bool = True


def _reg_change(fix_id: str) -> str:
    return " ; ".join(f"HKLM\\{w.key} : {w.value} = {w.target}" for w in helper.REG_FIXES[fix_id].writes)


CATALOG: dict[str, Meta] = {
    "lsa-ppl": Meta("Protéger LSA (lsass en processus protégé)", _reg_change("lsa-ppl"), reboot=True),
    "wdigest": Meta("Interdire les mots de passe en clair (WDigest)", _reg_change("wdigest")),
    "ps-scriptblock": Meta("Journaliser les scripts PowerShell", _reg_change("ps-scriptblock")),
    "llmnr": Meta("Désactiver LLMNR", _reg_change("llmnr")),
    "smb1": Meta("Désactiver SMBv1 (serveur)", _reg_change("smb1"), reboot=True),
    "rdp-close": Meta("Fermer le bureau à distance", _reg_change("rdp-close")),
    "rdp-nla": Meta("Exiger l'authentification réseau (NLA) pour le bureau à distance", _reg_change("rdp-nla")),
    "uac-on": Meta("Réactiver le contrôle de compte (UAC)", _reg_change("uac-on"), reboot=True),
    "uac-prompt": Meta("Demander le consentement UAC sur le bureau sécurisé", _reg_change("uac-prompt")),
    "guest-off": Meta("Désactiver le compte Invité", "Compte local RID 501 : désactivé"),
    "builtin-admin-off": Meta("Désactiver le compte Administrateur intégré", "Compte local RID 500 : désactivé"),
    "firewall-on": Meta("Réactiver le pare-feu Windows", "Pare-feu activé sur les profils désactivés", revertible=False),
    "defender-update": Meta("Mettre à jour les signatures de Microsoft Defender", "MpCmdRun.exe -SignatureUpdate", revertible=False),
}


# ─────────────────────────────── journal (fichier JSON, écriture atomique)
def history() -> list[dict]:
    try:
        data = json.loads(JOURNAL.read_text(encoding="utf-8"))
        return data if isinstance(data, list) else []
    except (OSError, json.JSONDecodeError):
        return []


def _save(records: list[dict]) -> None:
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=JOURNAL.parent, prefix=".remedies-", suffix=".json")
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(records[-MAX_JOURNAL:], f, ensure_ascii=False, indent=1)
    os.replace(tmp, JOURNAL)


def _record(**fields) -> dict:
    record = {"id": uuid.uuid4().hex[:12], "at": datetime.now(timezone.utc).isoformat(), "reverted_at": None, **fields}
    _save([*history(), record])
    return record


def _exclusive(action):
    if not _lock.acquire(blocking=False):
        raise ActionError(409, "Une correction est déjà en cours.")
    try:
        return action()
    finally:
        _lock.release()


# ─────────────────────────────── élévation
def _run_elevated(args: list[str]) -> int:
    return elevation.run_elevated(HELPER, args, nothing_changed="rien n'a été modifié.", timeout=420 if args[:1] == ["defender"] else elevation.TIMEOUT_S)


def _check_exit(code: int) -> None:
    if code == helper.EXIT_OK:
        return
    messages = {
        helper.EXIT_ARGS: (400, "Correction refusée par l'assistant (demande non conforme)."),
        helper.EXIT_SYSTEM: (502, "Windows a refusé la modification."),
        helper.EXIT_NOT_ADMIN: (403, "L'assistant n'a pas obtenu les droits administrateur."),
    }
    status, detail = messages.get(code, (500, f"Assistant de remèdes : code de sortie inattendu {code}."))
    raise ActionError(status, detail)


# ─────────────────────────────── lecteurs de vérification (sans admin)
def _read_reg(fix_id: str) -> list[int | None]:
    return [hardening.read_value(w.key, w.value) for w in helper.REG_FIXES[fix_id].writes]


def _account_disabled(rid: int) -> bool | None:
    import win32net

    users, _, _ = win32net.NetUserEnum(None, 3)
    user = next((u for u in users if u["user_id"] == rid), None)
    return None if user is None else bool(user["flags"] & 0x2)


def _firewall_off() -> list[str]:
    from app.services import firewall

    state, _ = firewall.read_state(force=True)
    return [name for bit, name in firewall.PROFILE_BITS.items() if state.enabled.get(bit) is False]


# ─────────────────────────────── remèdes de durcissement
def apply(fix_id: str, actor: str) -> dict:
    meta = CATALOG.get(fix_id)
    if meta is None:
        raise ActionError(404, "Correction inconnue.")
    if sys.platform != "win32":
        raise ActionError(501, "Corrections disponibles uniquement sous Windows.")

    def run() -> dict:
        if fix_id in helper.REG_FIXES:
            targets = [w.target for w in helper.REG_FIXES[fix_id].writes]
            previous = _read_reg(fix_id)
            if previous == targets:
                return {"ok": True, "already": True, "detail": "Déjà corrigé.", "record": None}
            _check_exit(_run_elevated(["reg", "--fix", fix_id]))
            if _read_reg(fix_id) != targets:
                raise ActionError(502, "La valeur relue ne correspond pas : correction non confirmée.")
            revertible = all(v in w.revert for v, w in zip(previous, helper.REG_FIXES[fix_id].writes))
        elif fix_id in helper.ACCOUNT_FIXES:
            rid = helper.ACCOUNT_FIXES[fix_id]
            previous = _account_disabled(rid)
            if previous is None or previous:
                return {"ok": True, "already": True, "detail": "Compte absent ou déjà désactivé.", "record": None}
            _check_exit(_run_elevated(["account", "--fix", fix_id]))
            if not _account_disabled(rid):
                raise ActionError(502, "Le compte est toujours actif : correction non confirmée.")
            revertible = True
        elif fix_id == "firewall-on":
            previous = _firewall_off()
            if not previous:
                return {"ok": True, "already": True, "detail": "Pare-feu déjà actif partout.", "record": None}
            _check_exit(_run_elevated(["firewall", "--profiles", ",".join(previous)]))
            if _firewall_off():
                raise ActionError(502, "Le pare-feu est toujours désactivé sur un profil.")
            revertible = False
        else:  # defender-update
            previous = None
            _check_exit(_run_elevated(["defender"]))
            revertible = False
        hardening.invalidate()
        record = _record(kind="hardening", fix=fix_id, label=meta.title, change=meta.change, previous=previous, revertible=revertible and meta.revertible, reboot=meta.reboot, actor=actor)
        detail = meta.title + " : fait." + (" Redémarrez pour que ce soit effectif." if meta.reboot else "")
        return {"ok": True, "already": False, "detail": detail, "record": record}

    return _exclusive(run)


# ─────────────────────────────── persistance : activer / désactiver (jamais supprimer)
def _approved_key(hive: str, approved: str) -> tuple[object, str]:
    import winreg

    return (winreg.HKEY_CURRENT_USER if hive == "HKCU" else winreg.HKEY_LOCAL_MACHINE), f"{helper.APPROVED_ROOT}\\{approved}"


def _startup_enabled(control: dict) -> bool:
    import winreg

    root, key = _approved_key(control["hive"], control["approved"])
    try:
        with winreg.OpenKey(root, key) as k:
            data = winreg.QueryValueEx(k, control["name"])[0]
    except OSError:
        data = None
    return persistence.startup_approved_enabled(data)


def _set_user_startup(control: dict, enabled: bool) -> None:
    """Entrée de démarrage de l'utilisateur : même écriture que le Gestionnaire des tâches, sans UAC."""
    import winreg

    root, key = _approved_key("HKCU", control["approved"])
    with winreg.CreateKeyEx(root, key, 0, winreg.KEY_SET_VALUE) as k:
        winreg.SetValueEx(k, control["name"], 0, winreg.REG_BINARY, helper.approved_blob(enabled))


def _task_enabled(path: str) -> bool | None:
    import pythoncom
    import win32com.client

    pythoncom.CoInitialize()
    try:
        service = win32com.client.Dispatch("Schedule.Service")
        service.Connect()
        folder, _, name = path.rpartition("\\")
        return bool(service.GetFolder(folder or "\\").GetTask(name).Enabled)
    except Exception:  # noqa: BLE001
        return None
    finally:
        pythoncom.CoUninitialize()


def _service_start(name: str) -> int | None:
    value = hardening.read_value(f"SYSTEM\\CurrentControlSet\\Services\\{name}", "Start")
    return value if isinstance(value, int) else None


def _current_state(control: dict) -> bool | None:
    kind = control["kind"]
    if kind == "startup":
        return _startup_enabled(control)
    if kind == "task":
        return _task_enabled(control["path"])
    start = _service_start(control["name"])
    return None if start is None else start != 4


def _apply_state(entry: persistence.Entry, enabled: bool, restore_start: int | None = None) -> None:
    control = entry.control or {}
    kind = control.get("kind")
    state = "on" if enabled else "off"
    if kind == "startup":
        if control["hive"] == "HKCU":
            _set_user_startup(control, enabled)
        else:
            _check_exit(_run_elevated(["startup", "--approved", control["approved"], "--name", control["name"], "--state", state]))
    elif kind == "task":
        _check_exit(_run_elevated(["task", "--path", helper.check_task_path(control["path"]), "--state", state]))
    elif kind == "service":
        start = restore_start if restore_start in (2, 3) else control.get("start") if control.get("start") in (2, 3) else 2
        args = ["service", "--name", helper.check_service_name(control["name"]), "--state", state, "--start", str(start)]
        if enabled and control.get("delayed"):
            args.append("--delayed")
        _check_exit(_run_elevated(args))
    else:
        raise ActionError(400, "Cette persistance ne se désactive pas depuis DeTecTX.")


def set_persistence(entry_id: str, enabled: bool, actor: str) -> dict:
    entry = persistence.current(entry_id)
    if entry is None:
        raise ActionError(404, "Entrée inconnue de l'inventaire courant : actualisez la vue.")
    control = entry.control
    if control is None:
        raise ActionError(400, "Cette persistance ne se désactive pas depuis DeTecTX (pilote, abonnement WMI ou RunOnce).")
    if control["kind"] in ("task", "service"):
        if entry.builtin:
            raise ActionError(403, "Tâche de Windows : non modifiable depuis DeTecTX.")
        if authenticode.verify(entry.target).verdict == "microsoft":
            raise ActionError(403, "Composant signé Microsoft : non modifiable depuis DeTecTX.")
        try:
            helper.check_task_path(control["path"]) if control["kind"] == "task" else helper.check_service_name(control["name"])
        except helper.Refused as e:
            raise ActionError(403, f"Refusé : {e}.") from e

    def run() -> dict:
        before = _current_state(control)
        if before is enabled:
            return {"ok": True, "already": True, "detail": "Déjà dans cet état.", "record": None}
        _apply_state(entry, enabled)
        if _current_state(control) is not enabled:
            raise ActionError(502, "État relu différent : modification non confirmée.")
        persistence.invalidate()
        record = _record(
            kind="persistence", fix="persistence-" + ("on" if enabled else "off"), entry_id=entry.id,
            label=f"{'Réactiver' if enabled else 'Désactiver'} au démarrage : {entry.name}",
            change=f"{persistence.LABEL[entry.mechanism]} · {entry.location}", previous=before,
            restore_start=control.get("start"), revertible=True, reboot=False, actor=actor,
        )
        return {"ok": True, "already": False, "detail": record["label"] + " : fait.", "record": record}

    return _exclusive(run)


# ─────────────────────────────── annulation
def revert(record_id: str, actor: str) -> dict:
    records = history()
    record = next((r for r in records if r.get("id") == record_id), None)
    if record is None:
        raise ActionError(404, "Correction introuvable dans le journal.")
    if not record.get("revertible") or record.get("reverted_at"):
        raise ActionError(409, "Cette correction ne peut pas (ou plus) être annulée.")

    def run() -> dict:
        fix = record["fix"]
        if record["kind"] == "hardening" and fix in helper.REG_FIXES:
            previous = record["previous"]
            _check_exit(_run_elevated(["reg", "--fix", fix, "--previous", helper.format_previous(previous)]))
            if _read_reg(fix) != previous:
                raise ActionError(502, "Valeur précédente non restaurée.")
            hardening.invalidate()
        elif record["kind"] == "hardening" and fix in helper.ACCOUNT_FIXES:
            _check_exit(_run_elevated(["account", "--fix", fix, "--undo"]))
            if _account_disabled(helper.ACCOUNT_FIXES[fix]):
                raise ActionError(502, "Le compte est toujours désactivé.")
            hardening.invalidate()
        elif record["kind"] == "persistence":
            entry = persistence.current(record["entry_id"])
            if entry is None or entry.control is None:
                raise ActionError(404, "Entrée absente de l'inventaire courant : actualisez la vue.")
            target = bool(record["previous"])
            _apply_state(entry, target, record.get("restore_start"))
            if _current_state(entry.control) is not target:
                raise ActionError(502, "État relu différent : annulation non confirmée.")
            persistence.invalidate()
        else:
            raise ActionError(409, "Cette correction ne peut pas être annulée.")
        fresh = history()
        for r in fresh:
            if r.get("id") == record_id:
                r["reverted_at"] = datetime.now(timezone.utc).isoformat()
                r["reverted_by"] = actor
        _save(fresh)
        return {"ok": True, "detail": f"Annulé : {record['label']}."}

    return _exclusive(run)


def catalog() -> dict:
    return {k: {"title": m.title, "change": m.change, "reboot": m.reboot, "revertible": m.revertible} for k, m in CATALOG.items()}
