"""Assistant de remèdes privilégié de DeTecTX — script AUTONOME, lancé avec élévation (UAC).

Même modèle que `fw_helper.py` : le backend reste sans droits administrateur ; pour corriger un
point faible du poste, il lance CE script via l'invite UAC de Windows et l'utilisateur confirme
dans une boîte de dialogue du système. Le script ne fait confiance à personne : il ne connaît
qu'une LISTE FERMÉE de corrections et revalide chaque argument.

    reg      --fix lsa-ppl [--previous absent,0]   écritures de registre figées par l'id
                                                    (--previous : annulation, valeurs autorisées)
    account  --fix guest-off|builtin-admin-off [--undo]
    firewall --profiles domain,private,public       réactive le pare-feu sur ces profils
    defender                                        met à jour les signatures Microsoft Defender
    startup  --approved Run|Run32|StartupFolder --name "X" --state off|on   (HKLM uniquement)
    task     --path "\\Dossier\\Tâche" --state off|on      (jamais sous \\Microsoft\\)
    service  --name X --state off|on [--start 2|3] [--delayed]   (jamais un service critique)

Tout est RÉVERSIBLE (désactiver, jamais supprimer) sauf la mise à jour des signatures et la
réactivation du pare-feu, qui ne se défont pas depuis DeTecTX.

Codes de sortie : 0 succès · 2 arguments refusés · 3 erreur système · 4 pas administrateur.
"""

from __future__ import annotations

import argparse
import os
import re
import struct
import subprocess
import sys
import time
from dataclasses import dataclass

EXIT_OK, EXIT_ARGS, EXIT_SYSTEM, EXIT_NOT_ADMIN = 0, 2, 3, 4

POLICIES_SYSTEM = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"


@dataclass(frozen=True)
class RegWrite:
    key: str  # sous HKLM
    value: str
    target: int  # valeur DWORD appliquée
    revert: frozenset  # valeurs précédentes acceptées à l'annulation (None = valeur absente)


@dataclass(frozen=True)
class RegFix:
    writes: tuple[RegWrite, ...]
    reboot: bool


# Catalogue fermé : clé, valeur et cible sont figées ici, jamais fournies par l'appelant.
REG_FIXES: dict[str, RegFix] = {
    # Protection LSA : lsass en processus protégé (bloque mimikatz & co). 2 = sans verrou UEFI,
    # donc désactivable ensuite sans manipulation du firmware.
    "lsa-ppl": RegFix((RegWrite(r"SYSTEM\CurrentControlSet\Control\Lsa", "RunAsPPL", 2, frozenset({None, 0})),), True),
    # WDigest : empêche le stockage des mots de passe en clair dans lsass.
    "wdigest": RegFix((RegWrite(r"SYSTEM\CurrentControlSet\Control\SecurityProviders\WDigest", "UseLogonCredential", 0, frozenset({None, 1})),), False),
    # Journalisation des blocs de script PowerShell (événement 4104) : voir ce qu'exécute PowerShell.
    "ps-scriptblock": RegFix((RegWrite(r"SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging", "EnableScriptBlockLogging", 1, frozenset({None, 0})),), False),
    # LLMNR : résolution de noms par multidiffusion, exploitée pour voler des empreintes NTLM.
    "llmnr": RegFix((RegWrite(r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient", "EnableMulticast", 0, frozenset({None, 1})),), False),
    # SMBv1 côté serveur (WannaCry, EternalBlue).
    "smb1": RegFix((RegWrite(r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1", 0, frozenset({None, 1})),), True),
    # Bureau à distance : fermé.
    "rdp-close": RegFix((RegWrite(r"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections", 1, frozenset({0})),), False),
    # Bureau à distance : authentification réseau (NLA) exigée avant la session.
    "rdp-nla": RegFix((RegWrite(r"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp", "UserAuthentication", 1, frozenset({None, 0})),), False),
    # Contrôle de compte d'utilisateur réactivé.
    "uac-on": RegFix((RegWrite(POLICIES_SYSTEM, "EnableLUA", 1, frozenset({0})),), True),
    # UAC : demander le consentement (niveau par défaut de Windows) sur le bureau sécurisé.
    "uac-prompt": RegFix(
        (
            RegWrite(POLICIES_SYSTEM, "ConsentPromptBehaviorAdmin", 5, frozenset({None, 0, 1, 2, 3, 4})),
            RegWrite(POLICIES_SYSTEM, "PromptOnSecureDesktop", 1, frozenset({None, 0})),
        ),
        False,
    ),
}
ACCOUNT_FIXES = {"guest-off": 501, "builtin-admin-off": 500}  # RID : indépendant de la langue
PROFILE_BITS = {"domain": 1, "private": 2, "public": 4}
APPROVED = {
    # StartupApproved\<sous-clé> -> où doit exister l'entrée (HKLM)
    "Run": ("reg", r"Software\Microsoft\Windows\CurrentVersion\Run"),
    "Run32": ("reg", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run"),
    "StartupFolder": ("dir", os.path.expandvars(r"%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp")),
}
APPROVED_ROOT = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved"
# Services dont l'arrêt casse Windows, la sécurité ou DeTecTX lui-même : jamais touchés.
CRITICAL_SERVICES = {
    "windefend", "wdnissvc", "sense", "mpssvc", "bfe", "eventlog", "wuauserv", "trustedinstaller", "rpcss",
    "rpceptmapper", "dcomlaunch", "lsm", "samss", "cryptsvc", "winmgmt", "schedule", "plugplay", "power",
    "profsvc", "gpsvc", "bits", "sysmon", "sysmon64", "securityhealthservice", "wscsvc", "appidsvc", "nsi", "dhcp", "dnscache",
}

NAME_RE = re.compile(r"^[^\x00-\x1f\\/:*?\"<>|]{1,260}$")  # nom de valeur de registre / de fichier
TASK_RE = re.compile(r"^\\[^\x00-\x1f\"<>|*?]{1,500}$")
SERVICE_RE = re.compile(r"^[A-Za-z0-9_.\-]{1,256}$")


class Refused(ValueError):
    pass


# ─────────────────────────────── validation (pur, testé)
def parse_previous(fix: RegFix, raw: str) -> list[int | None]:
    """« absent,0 » -> [None, 0] ; chaque valeur doit figurer dans les retours arrière autorisés."""
    tokens = [t.strip().lower() for t in raw.split(",")]
    if len(tokens) != len(fix.writes):
        raise Refused("nombre de valeurs précédentes incorrect")
    values: list[int | None] = []
    for token, write in zip(tokens, fix.writes):
        value = None if token == "absent" else int(token) if token.isdigit() else "?"
        if value == "?" or value not in write.revert:
            raise Refused(f"valeur de retour arrière interdite pour {write.value} : {token!r}")
        values.append(value)  # type: ignore[arg-type]
    return values


def format_previous(values: list[int | None]) -> str:
    return ",".join("absent" if v is None else str(v) for v in values)


def parse_profiles(raw: str) -> list[str]:
    tokens = {t.strip().lower() for t in raw.split(",") if t.strip()}
    if not tokens or any(p not in PROFILE_BITS for p in tokens):
        raise Refused("profil de pare-feu invalide")
    return sorted(tokens, key=list(PROFILE_BITS).index)


def check_task_path(path: str) -> str:
    if not TASK_RE.match(path) or ".." in path:
        raise Refused("chemin de tâche invalide")
    if path.lower().startswith("\\microsoft\\"):
        raise Refused("tâche de Windows (\\Microsoft\\) : refus")
    return path


def check_service_name(name: str) -> str:
    if not SERVICE_RE.match(name):
        raise Refused("nom de service invalide")
    if name.lower() in CRITICAL_SERVICES:
        raise Refused("service critique : refus")
    return name


def approved_blob(enabled: bool, now: float | None = None) -> bytes:
    """Valeur StartupApproved : 02 = activé, 03 = désactivé (+ date de désactivation, FILETIME)."""
    if enabled:
        return bytes([2]) + bytes(11)
    filetime = int(((now if now is not None else time.time()) + 11644473600) * 10_000_000)
    return bytes([3, 0, 0, 0]) + struct.pack("<Q", filetime)


def is_admin() -> bool:
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except (AttributeError, OSError):
        return False


# ─────────────────────────────── actions (élevées)
def _set_dword(key: str, value: str, data: int | None) -> None:
    import winreg

    if data is None:
        try:
            with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY) as k:
                winreg.DeleteValue(k, value)
        except FileNotFoundError:
            pass
        return
    with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY) as k:
        winreg.SetValueEx(k, value, 0, winreg.REG_DWORD, data)


def do_reg(fix_id: str, previous: str | None) -> None:
    fix = REG_FIXES[fix_id]
    values = parse_previous(fix, previous) if previous is not None else [w.target for w in fix.writes]
    for write, data in zip(fix.writes, values):
        _set_dword(write.key, write.value, data)


def do_account(fix_id: str, undo: bool) -> None:
    import win32net

    rid = ACCOUNT_FIXES[fix_id]
    users, _, _ = win32net.NetUserEnum(None, 3)
    user = next((u for u in users if u["user_id"] == rid), None)
    if user is None:
        return  # compte absent : rien à faire
    flags = user["flags"] & ~0x2 if undo else user["flags"] | 0x2  # UF_ACCOUNTDISABLE
    win32net.NetUserSetInfo(None, user["name"], 1008, {"flags": flags})


def do_firewall(profiles: list[str]) -> None:
    import win32com.client

    policy = win32com.client.Dispatch("HNetCfg.FwPolicy2")
    for p in profiles:
        policy.SetFirewallEnabled(PROFILE_BITS[p], True)


def do_defender() -> None:
    root = os.environ.get("ProgramFiles", r"C:\Program Files")
    exe = os.path.join(root, "Windows Defender", "MpCmdRun.exe")
    if not os.path.isfile(exe):
        raise RuntimeError("Microsoft Defender absent")
    r = subprocess.run([exe, "-SignatureUpdate"], capture_output=True, timeout=300, check=False)
    if r.returncode != 0:
        raise RuntimeError(f"MpCmdRun code {r.returncode}")


def do_startup(approved: str, name: str, enabled: bool) -> None:
    import winreg

    kind, where = APPROVED[approved]
    if kind == "reg":
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, where, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            winreg.QueryValueEx(k, name)  # FileNotFoundError si l'entrée n'existe pas
    elif not os.path.isfile(os.path.join(where, name)):
        raise Refused("fichier absent du dossier Démarrage commun")
    with winreg.CreateKeyEx(winreg.HKEY_LOCAL_MACHINE, f"{APPROVED_ROOT}\\{approved}", 0, winreg.KEY_SET_VALUE | winreg.KEY_WOW64_64KEY) as k:
        winreg.SetValueEx(k, name, 0, winreg.REG_BINARY, approved_blob(enabled))


def do_task(path: str, enabled: bool) -> None:
    import win32com.client

    service = win32com.client.Dispatch("Schedule.Service")
    service.Connect()
    folder, _, name = path.rpartition("\\")
    task = service.GetFolder(folder or "\\").GetTask(name)
    task.Enabled = enabled


def do_service(name: str, enabled: bool, start: int, delayed: bool) -> None:
    import win32service

    manager = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_CONNECT)
    try:
        handle = win32service.OpenService(manager, name, win32service.SERVICE_QUERY_CONFIG | win32service.SERVICE_CHANGE_CONFIG | win32service.SERVICE_STOP | win32service.SERVICE_QUERY_STATUS)
        try:
            config = win32service.QueryServiceConfig(handle)
            service_type, binary = config[0], (config[3] or "").lower()
            if not service_type & 0x30 or "svchost.exe" in binary:
                raise Refused("service partagé de Windows ou pilote : refus")
            unchanged = win32service.SERVICE_NO_CHANGE
            new_start = win32service.SERVICE_DISABLED if not enabled else start
            win32service.ChangeServiceConfig(handle, unchanged, new_start, unchanged, None, None, 0, None, None, None, None)
            if enabled:
                win32service.ChangeServiceConfig2(handle, win32service.SERVICE_CONFIG_DELAYED_AUTO_START_INFO, bool(delayed))
            else:
                try:
                    win32service.ControlService(handle, win32service.SERVICE_CONTROL_STOP)
                except win32service.error:
                    pass  # déjà arrêté ou arrêt refusé : il ne redémarrera plus de lui-même
        finally:
            win32service.CloseServiceHandle(handle)
    finally:
        win32service.CloseServiceHandle(manager)


# ─────────────────────────────── point d'entrée
def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="remedy_helper", description="Assistant de remèdes DeTecTX (élevé).")
    sub = parser.add_subparsers(dest="op", required=True)
    r = sub.add_parser("reg")
    r.add_argument("--fix", required=True)
    r.add_argument("--previous")
    a = sub.add_parser("account")
    a.add_argument("--fix", required=True)
    a.add_argument("--undo", action="store_true")
    f = sub.add_parser("firewall")
    f.add_argument("--profiles", required=True)
    sub.add_parser("defender")
    s = sub.add_parser("startup")
    s.add_argument("--approved", required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--state", required=True, choices=["on", "off"])
    t = sub.add_parser("task")
    t.add_argument("--path", required=True)
    t.add_argument("--state", required=True, choices=["on", "off"])
    v = sub.add_parser("service")
    v.add_argument("--name", required=True)
    v.add_argument("--state", required=True, choices=["on", "off"])
    v.add_argument("--start", type=int, default=2, choices=[2, 3])
    v.add_argument("--delayed", action="store_true")
    return parser


def validate(args) -> None:
    """Revalidation complète AVANT de vérifier les droits et de toucher au système."""
    if args.op == "reg":
        if args.fix not in REG_FIXES:
            raise Refused("correction inconnue")
        if args.previous is not None:
            parse_previous(REG_FIXES[args.fix], args.previous)
    elif args.op == "account" and args.fix not in ACCOUNT_FIXES:
        raise Refused("correction de compte inconnue")
    elif args.op == "firewall":
        parse_profiles(args.profiles)
    elif args.op == "startup":
        if args.approved not in APPROVED or not NAME_RE.match(args.name):
            raise Refused("entrée de démarrage invalide")
    elif args.op == "task":
        check_task_path(args.path)
    elif args.op == "service":
        check_service_name(args.name)


def main(argv: list[str] | None = None) -> int:
    try:
        args = _parser().parse_args(argv)
    except SystemExit:
        return EXIT_ARGS
    try:
        validate(args)
    except Refused as e:
        print(f"refusé : {e}", file=sys.stderr)
        return EXIT_ARGS
    if not is_admin():
        print("droits administrateur requis", file=sys.stderr)
        return EXIT_NOT_ADMIN
    try:
        if args.op == "reg":
            do_reg(args.fix, args.previous)
        elif args.op == "account":
            do_account(args.fix, args.undo)
        elif args.op == "firewall":
            do_firewall(parse_profiles(args.profiles))
        elif args.op == "defender":
            do_defender()
        elif args.op == "startup":
            do_startup(args.approved, args.name, args.state == "on")
        elif args.op == "task":
            do_task(args.path, args.state == "on")
        elif args.op == "service":
            do_service(args.name, args.state == "on", args.start, args.delayed)
    except Refused as e:
        print(f"refusé : {e}", file=sys.stderr)
        return EXIT_ARGS
    except Exception as e:  # noqa: BLE001 - tout échec système -> code dédié
        print(f"système : {e}", file=sys.stderr)
        return EXIT_SYSTEM
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
