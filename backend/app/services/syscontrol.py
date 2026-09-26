"""Contrôle système niveau utilisateur (sans admin) : démarrage, raccourcis, localisation.

Opérations initiées par l'utilisateur depuis l'interface (avec confirmation côté UI).
Tout est au niveau HKEY_CURRENT_USER — pas de modification HKLM/système global.
"""

import os
import re
import subprocess
import winreg

_HKCU = winreg.HKEY_CURRENT_USER
_HKLM = winreg.HKEY_LOCAL_MACHINE
_RUN = r"Software\Microsoft\Windows\CurrentVersion\Run"
_APPROVED = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
_LOCATION = r"Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\location"

_SAFE = re.compile(r"^[^'\";\r\n|&<>]{1,255}$")  # anti-injection basique


class SysError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


# ───────────────────────── Démarrage ─────────────────────────
def _read_run(hive) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    try:
        k = winreg.OpenKey(hive, _RUN)
    except FileNotFoundError:
        return out
    i = 0
    while True:
        try:
            name, val, _ = winreg.EnumValue(k, i)
            out.append((name, str(val)))
            i += 1
        except OSError:
            break
    winreg.CloseKey(k)
    return out


def _is_enabled(name: str) -> bool:
    try:
        k = winreg.OpenKey(_HKCU, _APPROVED)
        try:
            val, _ = winreg.QueryValueEx(k, name)
            return not (isinstance(val, (bytes, bytearray)) and len(val) and val[0] == 3)
        except FileNotFoundError:
            return True
        finally:
            winreg.CloseKey(k)
    except FileNotFoundError:
        return True


def list_startup() -> list[dict]:
    items: list[dict] = []
    for name, cmd in _read_run(_HKCU):
        items.append({"name": name, "command": cmd, "location": "HKCU", "enabled": _is_enabled(name), "editable": True})
    for name, cmd in _read_run(_HKLM):
        items.append({"name": name, "command": cmd, "location": "HKLM", "enabled": True, "editable": False})
    folder = os.path.join(os.environ.get("APPDATA", ""), r"Microsoft\Windows\Start Menu\Programs\Startup")
    if os.path.isdir(folder):
        for f in os.listdir(folder):
            if f.lower() == "desktop.ini":
                continue
            items.append({"name": f, "command": os.path.join(folder, f), "location": "Dossier", "enabled": True, "editable": False})
    return items


def set_startup_enabled(name: str, enable: bool) -> dict:
    # Vérifie que l'entrée existe en HKCU Run (éditable).
    if name not in dict(_read_run(_HKCU)):
        raise SysError(404, "Entrée de démarrage HKCU introuvable (les entrées système/dossier ne sont pas modifiables ici).")
    key = winreg.CreateKey(_HKCU, _APPROVED)
    blob = bytes([2 if enable else 3]) + b"\x00" * 11
    winreg.SetValueEx(key, name, 0, winreg.REG_BINARY, blob)
    winreg.CloseKey(key)
    return {"name": name, "enabled": enable}


# ───────────────────────── Raccourcis ─────────────────────────
def create_shortcut(name: str, target: str, args: str = "", workdir: str = "") -> dict:
    if not _SAFE.match(name) or not _SAFE.match(target):
        raise SysError(422, "Nom ou cible invalide (caractères interdits).")
    if not os.path.exists(target):
        raise SysError(422, "La cible n'existe pas sur le disque.")
    desktop = os.path.join(os.environ.get("USERPROFILE", ""), "Desktop")
    lnk = os.path.join(desktop, f"{name}.lnk")
    if not workdir:
        workdir = os.path.dirname(target)
    ps = (
        "$ws=New-Object -ComObject WScript.Shell;"
        f"$s=$ws.CreateShortcut('{lnk}');"
        f"$s.TargetPath='{target}';"
        f"$s.Arguments='{args}';"
        f"$s.WorkingDirectory='{workdir}';"
        "$s.Save()"
    )
    r = subprocess.run(
        ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps],
        capture_output=True, text=True, timeout=15,
    )
    if r.returncode != 0 or not os.path.exists(lnk):
        raise SysError(500, f"Création du raccourci échouée : {r.stderr.strip()[:200] or 'inconnu'}")
    return {"created": True, "path": lnk}


# ───────────────────────── Localisation ─────────────────────────
def get_location() -> dict:
    try:
        k = winreg.OpenKey(_HKCU, _LOCATION)
        try:
            val, _ = winreg.QueryValueEx(k, "Value")
            return {"allowed": str(val) == "Allow"}
        finally:
            winreg.CloseKey(k)
    except FileNotFoundError:
        return {"allowed": True}


def set_location(allowed: bool) -> dict:
    key = winreg.CreateKey(_HKCU, _LOCATION)
    winreg.SetValueEx(key, "Value", 0, winreg.REG_SZ, "Allow" if allowed else "Deny")
    winreg.CloseKey(key)
    return {"allowed": allowed}
