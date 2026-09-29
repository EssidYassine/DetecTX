"""Durcissement : comment Windows est configuré face au vol d'identifiants, à l'élévation et aux
mouvements latéraux. Lecture seule, sans droits admin (~50 ms, mis en cache 60 s).

Deux temps, comme la posture :
  - `read_facts()` lit le poste (registre, WMI DeviceGuard, comptes locaux, Centre de sécurité,
    pare-feu, dernier rapport Windows Update) ;
  - `evaluate(facts)` est PUR (testé sans Windows) : faits -> contrôles.

Chaque contrôle dit ce qui a été lu (traçabilité), pourquoi c'est important, et comment le
corriger : un REMÈDE DeTecTX (bouton, via l'invite UAC, réversible) quand la correction est sûre,
sinon un lien vers le bon écran de Windows (firmware, chiffrement, pilotes : l'humain décide).
"""

from __future__ import annotations

import logging
import sys
import time
from dataclasses import asdict, dataclass, field
from typing import Literal

log = logging.getLogger("detectx.hardening")

State = Literal["ok", "weak", "na", "unknown"]
Level = Literal["high", "medium", "low"]

THEMES = {
    "boot": "Démarrage & disque",
    "identity": "Identifiants",
    "elevation": "Élévation",
    "network": "Surface réseau",
    "visibility": "Visibilité",
    "accounts": "Comptes",
    "defense": "Défenses",
}

CACHE_S = 60


@dataclass
class Control:
    id: str
    theme: str
    title: str
    state: State
    level: Level  # gravité SI faible
    observed: str  # ce qui a été lu (clé de registre, valeur…)
    why: str
    advice: str | None = None  # correction décrite (toujours présente si faible)
    remedy: str | None = None  # id d'un remède DeTecTX (bouton)
    link: dict | None = None  # {"uri": "ms-settings:…", "label": "…"}
    reboot: bool = False
    attack: str | None = None
    details: list[str] = field(default_factory=list)


# ─────────────────────────────── évaluation (pure)
def _reg(facts: dict, name: str):
    return facts.get("reg", {}).get(name)


def evaluate(facts: dict) -> list[Control]:
    c: list[Control] = []
    home = str(facts.get("edition") or "").lower().startswith("core")

    # Démarrage & disque
    sb = facts.get("secure_boot")
    c.append(Control(
        "secure-boot", "boot", "Démarrage sécurisé (Secure Boot)",
        "unknown" if sb is None else "ok" if sb == 1 else "weak", "medium",
        f"SecureBoot\\State\\UEFISecureBootEnabled = {sb if sb is not None else 'absent'}",
        "Empêche un bootkit de se charger avant Windows.",
        advice="S'active dans le firmware (UEFI) de la machine, au démarrage : option « Secure Boot ».",
        attack="T1542.003",
    ))
    bl = facts.get("bitlocker")
    bl_state: State = "na" if bl in (None, 0) else "ok" if bl in (1, 3, 6) else "weak"
    c.append(Control(
        "bitlocker", "boot", "Chiffrement du disque système",
        bl_state, "medium",
        f"C: · protection BitLocker = {_BITLOCKER.get(bl, bl)}",
        "Un disque volé ou démarré depuis une clé USB reste illisible.",
        advice="Activez le chiffrement de l'appareil, en sauvegardant d'abord la clé de récupération.",
        link={"uri": "ms-settings:deviceencryption", "label": "Ouvrir le chiffrement de l'appareil"},
    ))
    dg = facts.get("device_guard") or {}
    running = set(dg.get("running") or [])
    hvci = 2 in running if dg else _reg(facts, "HVCI") == 1
    c.append(Control(
        "memory-integrity", "boot", "Intégrité de la mémoire (HVCI)",
        "ok" if hvci else "weak", "medium",
        f"Device Guard : services actifs {sorted(running) or 'aucun'}" if dg else f"HVCI\\Enabled = {_reg(facts, 'HVCI')}",
        "Bloque le chargement de pilotes non signés ou vulnérables dans le noyau.",
        advice="Activez « Intégrité de la mémoire » dans Sécurité Windows (Windows vérifie d'abord la compatibilité des pilotes).",
        link={"uri": "windowsdefender://coreisolation", "label": "Ouvrir l'isolation du noyau"},
        attack="T1068",
    ))

    # Identifiants
    ppl = _reg(facts, "RunAsPPL")
    c.append(Control(
        "lsa-ppl", "identity", "Protection de LSA (lsass protégé)",
        "ok" if ppl in (1, 2) else "weak", "high",
        f"Control\\Lsa\\RunAsPPL = {ppl if ppl is not None else 'absent'}",
        "Empêche les outils de vol d'identifiants (mimikatz…) de lire la mémoire de lsass.",
        advice="Activer RunAsPPL = 2 (protection sans verrou UEFI, désactivable ensuite). Redémarrage requis.",
        remedy="lsa-ppl", reboot=True, attack="T1003.001",
    ))
    wd = _reg(facts, "UseLogonCredential")
    c.append(Control(
        "wdigest", "identity", "Mots de passe en clair en mémoire (WDigest)",
        "weak" if wd == 1 else "ok", "high",
        f"WDigest\\UseLogonCredential = {wd if wd is not None else 'absent (désactivé par défaut)'}",
        "WDigest actif garde les mots de passe en clair dans lsass.",
        advice="Forcer UseLogonCredential = 0.",
        remedy="wdigest", attack="T1003.001",
    ))
    cg = 1 in running
    c.append(Control(
        "credential-guard", "identity", "Credential Guard",
        "na" if home else "ok" if cg else "weak", "low",
        "Édition Famille : fonctionnalité absente" if home else f"Device Guard : Credential Guard {'actif' if cg else 'inactif'}",
        "Isole les secrets d'authentification dans une enclave virtualisée.",
        advice=None if home else "S'active par stratégie de groupe (éditions Pro/Entreprise).",
        attack="T1003",
    ))

    # Élévation
    lua, cpba, secure = _reg(facts, "EnableLUA"), _reg(facts, "ConsentPromptBehaviorAdmin"), _reg(facts, "PromptOnSecureDesktop")
    uac_off = lua == 0
    silent = cpba == 0
    c.append(Control(
        "uac", "elevation", "Contrôle de compte d'utilisateur (UAC)",
        "weak" if uac_off or silent or secure == 0 else "ok", "high" if uac_off or silent else "low",
        f"EnableLUA = {_v(lua)} · ConsentPromptBehaviorAdmin = {_v(cpba)} · PromptOnSecureDesktop = {_v(secure)}",
        "Sans invite UAC, tout programme lancé par un administrateur obtient les pleins pouvoirs.",
        advice="Réactiver UAC (redémarrage requis)." if uac_off else "Demander le consentement sur le bureau sécurisé (niveau par défaut de Windows).",
        remedy="uac-on" if uac_off else "uac-prompt", reboot=uac_off, attack="T1548.002",
    ))

    # Surface réseau
    smb1_on = bool(facts.get("smb1_installed")) and _reg(facts, "SMB1") != 0
    c.append(Control(
        "smb1", "network", "SMBv1 (protocole de WannaCry)",
        "weak" if smb1_on else "ok", "high",
        f"Pilote SMBv1 {'installé' if facts.get('smb1_installed') else 'absent'} · SMB1 = {_v(_reg(facts, 'SMB1'))}",
        "Protocole obsolète exploité par EternalBlue / WannaCry.",
        advice="Désactiver SMBv1 côté serveur (redémarrage requis).",
        remedy="smb1", reboot=True, attack="T1210",
    ))
    deny = _reg(facts, "fDenyTSConnectionsPolicy")
    deny = deny if deny is not None else _reg(facts, "fDenyTSConnections")
    nla = _reg(facts, "UserAuthentication")
    rdp_open = deny == 0
    c.append(Control(
        "rdp", "network", "Bureau à distance",
        "weak" if rdp_open else "ok", "high" if rdp_open and nla == 0 else "medium",
        f"fDenyTSConnections = {_v(deny)}" + (f" · NLA = {_v(nla)}" if rdp_open else ""),
        "Un bureau à distance ouvert est la première porte des rançongiciels.",
        advice="Fermer le bureau à distance s'il ne sert pas." if not (rdp_open and nla == 0) else "Exiger l'authentification réseau (NLA), ou fermer le bureau à distance.",
        remedy="rdp-nla" if rdp_open and nla == 0 else "rdp-close", attack="T1021.001",
    ))
    mc = _reg(facts, "EnableMulticast")
    c.append(Control(
        "llmnr", "network", "Résolution de noms LLMNR",
        "ok" if mc == 0 else "weak", "low",
        f"DNSClient\\EnableMulticast = {mc if mc is not None else 'absent (LLMNR actif)'}",
        "Un attaquant du même réseau peut répondre à la place du vrai serveur et capter des empreintes NTLM.",
        advice="Désactiver LLMNR (stratégie EnableMulticast = 0).",
        remedy="llmnr", attack="T1557.001",
    ))

    # Visibilité
    sbl = _reg(facts, "EnableScriptBlockLogging")
    c.append(Control(
        "ps-scriptblock", "visibility", "Journalisation des scripts PowerShell",
        "ok" if sbl == 1 else "weak", "medium",
        f"ScriptBlockLogging\\EnableScriptBlockLogging = {sbl if sbl is not None else 'absent'}",
        "Sans elle, un script PowerShell malveillant (même obfusqué) ne laisse aucune trace lisible.",
        advice="Activer la journalisation des blocs de script (événement 4104, lu par DeTecTX).",
        remedy="ps-scriptblock", attack="T1059.001",
    ))
    sysmon = facts.get("sysmon")
    c.append(Control(
        "sysmon", "visibility", "Sysmon",
        "ok" if sysmon else "weak", "medium",
        "Service Sysmon " + ("présent" if sysmon else "absent"),
        "Trace en détail processus, connexions et registre : la matière première des détections.",
        advice="Installer Sysmon (Microsoft Sysinternals) avec la configuration fournie dans collectors/.",
        link={"uri": "https://learn.microsoft.com/sysinternals/downloads/sysmon", "label": "Page officielle de Sysmon"},
    ))

    # Comptes
    accounts = facts.get("accounts")
    if accounts is None:
        c.append(Control("accounts", "accounts", "Comptes locaux", "unknown", "low", "Comptes illisibles", "—"))
    else:
        by_rid = {a["rid"]: a for a in accounts}
        for rid, cid, label, remedy in ((500, "builtin-admin", "Compte Administrateur intégré", "builtin-admin-off"), (501, "guest", "Compte Invité", "guest-off")):
            a = by_rid.get(rid)
            active = bool(a and not a["disabled"])
            c.append(Control(
                cid, "accounts", label,
                "weak" if active else "ok", "high",
                f"« {a['name']} » {'actif' if active else 'désactivé'}" if a else "absent",
                "Compte connu de tous les attaquants, cible des attaques par force brute." if rid == 500 else "Accès sans mot de passe au poste.",
                advice="Désactiver ce compte.",
                remedy=remedy, attack="T1078.001",
            ))
        admins = facts.get("admins") or []
        me = str(facts.get("current_user") or "").lower()
        daily_admin = any(n.split("\\")[-1].lower() == me for n in admins)
        c.append(Control(
            "daily-admin", "accounts", "Compte du quotidien administrateur",
            "weak" if daily_admin else "ok", "medium",
            f"Administrateurs : {', '.join(admins) or '—'} · session : {facts.get('current_user') or '?'}",
            "Un logiciel piégé ouvert depuis un compte administrateur obtient d'un clic les droits complets.",
            advice="Créer un compte administrateur séparé, puis passer ce compte en utilisateur standard. "
            "DeTecTX ne le fait pas pour vous : une erreur vous fermerait l'accès à votre propre poste.",
            link={"uri": "ms-settings:otherusers", "label": "Ouvrir Autres utilisateurs"},
            attack="T1078.003",
            details=[f"Administrateur : {n}" for n in admins],
        ))
        blank = [a["name"] for a in accounts if not a["disabled"] and a.get("no_password_required")]
        active = [a["name"] for a in accounts if not a["disabled"]]
        c.append(Control(
            "no-password", "accounts", "Comptes actifs sans mot de passe obligatoire",
            "weak" if blank else "ok", "high",
            f"Comptes actifs : {', '.join(active) or '—'}" + (f" · sans mot de passe requis : {', '.join(blank)}" if blank else ""),
            "Un compte qui n'exige pas de mot de passe s'ouvre sans rien savoir.",
            advice="Définir un mot de passe pour ces comptes, ou les désactiver.",
            link={"uri": "ms-settings:otherusers", "label": "Ouvrir Autres utilisateurs"},
            details=[f"Compte actif : {n}" for n in active],
        ))

    # Défenses (déjà suivies par la posture : reprises ici pour avoir le tableau complet)
    avs = facts.get("antivirus")
    if avs is None:
        c.append(Control("antivirus", "defense", "Antivirus", "unknown", "high", "Centre de sécurité illisible", "—"))
    else:
        active_avs = [a for a in avs if a["active"]]
        stale = [a for a in active_avs if not a["up_to_date"]]
        defender_stale = any("defender" in a["name"].lower() for a in stale)
        c.append(Control(
            "antivirus", "defense", "Antivirus actif et à jour",
            "weak" if not active_avs or stale else "ok", "high",
            " · ".join(f"{a['name']} : {'actif' if a['active'] else 'passif'}, signatures {'à jour' if a['up_to_date'] else 'périmées'}" for a in avs) or "aucun antivirus déclaré",
            "Première barrière contre les logiciels malveillants connus.",
            advice="Mettre à jour les signatures." if stale else "Réactiver la protection en temps réel." if not active_avs else None,
            remedy="defender-update" if defender_stale else None,
            link=None if defender_stale else {"uri": "windowsdefender://threat", "label": "Ouvrir Sécurité Windows"},
            attack="T1562.001",
        ))
    fw = facts.get("firewall")
    if fw is None:
        c.append(Control("firewall", "defense", "Pare-feu", "unknown", "high", "Pare-feu illisible", "—"))
    else:
        off = [p for p, on in fw.items() if on is False]
        c.append(Control(
            "firewall", "defense", "Pare-feu actif sur tous les profils",
            "weak" if off else "ok", "high",
            " · ".join(f"{p} : {'actif' if on else 'désactivé' if on is False else '?'}" for p, on in fw.items()),
            "Sans pare-feu, chaque service en écoute est joignable depuis le réseau.",
            advice=f"Réactiver le pare-feu ({', '.join(off)})." if off else None,
            remedy="firewall-on" if off else None, attack="T1562.004",
        ))
    up = facts.get("updates")
    if up is None:
        c.append(Control("updates", "defense", "Mises à jour Windows", "unknown", "medium", "Analyse Windows Update pas encore disponible", "—", link={"uri": "ms-settings:windowsupdate", "label": "Ouvrir Windows Update"}))
    else:
        c.append(Control(
            "updates", "defense", "Mises à jour Windows installées",
            "weak" if up["pending"] else "ok", "high" if up["security"] else "medium",
            f"{up['pending']} mise(s) à jour en attente, dont {up['security']} de sécurité",
            "Chaque mise à jour de sécurité ferme des failles déjà connues des attaquants.",
            advice="Installer les mises à jour en attente.",
            link={"uri": "ms-settings:windowsupdate", "label": "Ouvrir Windows Update"},
        ))
    return c


_BITLOCKER = {None: "non disponible", 0: "non chiffrable", 1: "actif", 2: "désactivé", 3: "chiffrement en cours", 4: "déchiffrement en cours", 5: "suspendu", 6: "actif (verrouillé)", 8: "en attente d'activation"}


def _v(value) -> str:
    return "absent" if value is None else str(value)


def summarize(controls: list[Control]) -> dict:
    scored = [c for c in controls if c.state in ("ok", "weak")]
    ok = sum(1 for c in scored if c.state == "ok")
    weight = {"high": 3, "medium": 2, "low": 1}
    total = sum(weight[c.level] for c in scored) or 1
    score = round(100 * sum(weight[c.level] for c in scored if c.state == "ok") / total)
    grade = "A" if score >= 90 else "B" if score >= 75 else "C" if score >= 60 else "D" if score >= 40 else "E"
    return {
        "ok": ok,
        "total": len(scored),
        "weak": {lvl: sum(1 for c in scored if c.state == "weak" and c.level == lvl) for lvl in ("high", "medium", "low")},
        "fixable": sum(1 for c in scored if c.state == "weak" and c.remedy),
        "score": score,
        "grade": grade,
    }


# ─────────────────────────────── lecture du poste (Windows)
_REG_VALUES = {
    # nom logique -> (clé HKLM, valeur)
    "RunAsPPL": (r"SYSTEM\CurrentControlSet\Control\Lsa", "RunAsPPL"),
    "UseLogonCredential": (r"SYSTEM\CurrentControlSet\Control\SecurityProviders\WDigest", "UseLogonCredential"),
    "EnableLUA": (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "EnableLUA"),
    "ConsentPromptBehaviorAdmin": (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "ConsentPromptBehaviorAdmin"),
    "PromptOnSecureDesktop": (r"SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System", "PromptOnSecureDesktop"),
    "SMB1": (r"SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters", "SMB1"),
    "fDenyTSConnections": (r"SYSTEM\CurrentControlSet\Control\Terminal Server", "fDenyTSConnections"),
    "fDenyTSConnectionsPolicy": (r"SOFTWARE\Policies\Microsoft\Windows NT\Terminal Services", "fDenyTSConnections"),
    "UserAuthentication": (r"SYSTEM\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp", "UserAuthentication"),
    "EnableMulticast": (r"SOFTWARE\Policies\Microsoft\Windows NT\DNSClient", "EnableMulticast"),
    "EnableScriptBlockLogging": (r"SOFTWARE\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging", "EnableScriptBlockLogging"),
    "HVCI": (r"SYSTEM\CurrentControlSet\Control\DeviceGuard\Scenarios\HypervisorEnforcedCodeIntegrity", "Enabled"),
    "SecureBoot": (r"SYSTEM\CurrentControlSet\Control\SecureBoot\State", "UEFISecureBootEnabled"),
}


def read_value(key: str, name: str):
    import winreg

    try:
        with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key, 0, winreg.KEY_READ | winreg.KEY_WOW64_64KEY) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def _key_exists(key: str) -> bool:
    import winreg

    try:
        winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, key).Close()
        return True
    except OSError:
        return False


def _safe(fn, default=None):
    try:
        return fn()
    except Exception:
        log.debug("lecture de durcissement impossible : %s", getattr(fn, "__name__", fn), exc_info=True)
        return default


def _device_guard() -> dict | None:
    import win32com.client

    svc = win32com.client.Dispatch("WbemScripting.SWbemLocator").ConnectServer(".", r"root\Microsoft\Windows\DeviceGuard")
    for d in svc.ExecQuery("SELECT * FROM Win32_DeviceGuard"):
        return {"vbs": d.VirtualizationBasedSecurityStatus, "running": [int(x) for x in (d.SecurityServicesRunning or [])]}
    return None


def _bitlocker() -> int | None:
    import win32com.client

    item = win32com.client.Dispatch("Shell.Application").NameSpace(17).ParseName("C:\\")
    value = item.ExtendedProperty("System.Volume.BitLockerProtection") if item else None
    return int(value) if value is not None else None


def _accounts() -> tuple[list[dict], list[str]]:
    import win32net
    import win32security

    users, _, _ = win32net.NetUserEnum(None, 3)
    accounts = [
        {"name": u["name"], "rid": u["user_id"], "disabled": bool(u["flags"] & 0x2), "no_password_required": bool(u["flags"] & 0x20)}
        for u in users
        if u["user_id"] not in (503, 504)  # DefaultAccount, WDAGUtilityAccount : comptes système de Windows
    ]
    group, _, _ = win32security.LookupAccountSid(None, win32security.ConvertStringSidToSid("S-1-5-32-544"))
    members, _, _ = win32net.NetLocalGroupGetMembers(None, group, 2)
    return accounts, [m["domainandname"] for m in members]


def _defense() -> list[dict] | None:
    from app.services import security_center

    state = security_center.defense()
    if not state.available:
        return None
    return [{"name": p.name, "active": p.active, "up_to_date": p.up_to_date} for p in state.products if p.kind == "antivirus"]


def _firewall() -> dict | None:
    from app.services import firewall

    state, _ = firewall.read_state()
    if not state.available:
        return None
    return {name: state.enabled.get(bit) for bit, name in firewall.PROFILE_BITS.items()}


def _updates() -> dict | None:
    import re

    from app.threatintel import vulns

    report = vulns.last_report()
    if not report or not report.get("windows_update", {}).get("available"):
        return None
    updates = report["windows_update"].get("updates", [])
    security = re.compile(r"^(security updates|critical updates|mises à jour de sécurité|mises à jour critiques)$", re.IGNORECASE)
    return {"pending": len(updates), "security": sum(1 for u in updates if u.get("severity") or any(security.match(c) for c in u.get("categories", [])))}


def read_facts() -> dict:
    if sys.platform != "win32":
        return {}
    import pythoncom

    pythoncom.CoInitialize()
    try:
        accounts = _safe(_accounts)
        import win32api

        return {
            "edition": read_value(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "EditionID"),
            "reg": {name: read_value(key, value) for name, (key, value) in _REG_VALUES.items()},
            "secure_boot": read_value(*_REG_VALUES["SecureBoot"]),
            "bitlocker": _safe(_bitlocker),
            "device_guard": _safe(_device_guard),
            "smb1_installed": _key_exists(r"SYSTEM\CurrentControlSet\Services\srv") or _key_exists(r"SYSTEM\CurrentControlSet\Services\mrxsmb10"),
            "sysmon": _key_exists(r"SYSTEM\CurrentControlSet\Services\Sysmon64") or _key_exists(r"SYSTEM\CurrentControlSet\Services\Sysmon"),
            "accounts": accounts[0] if accounts else None,
            "admins": accounts[1] if accounts else [],
            "current_user": _safe(win32api.GetUserName),
            "antivirus": _safe(_defense),
            "firewall": _safe(_firewall),
            "updates": _safe(_updates),
        }
    finally:
        pythoncom.CoUninitialize()


_cache: dict = {"at": 0.0, "value": None}


def snapshot(force: bool = False) -> dict:
    if not force and _cache["value"] is not None and time.monotonic() - _cache["at"] < CACHE_S:
        return _cache["value"]
    controls = evaluate(read_facts()) if sys.platform == "win32" else []
    value = {"controls": [asdict(c) for c in controls], "summary": summarize(controls), "themes": THEMES}
    _cache.update(at=time.monotonic(), value=value)
    return value


def invalidate() -> None:
    _cache["at"] = 0.0
