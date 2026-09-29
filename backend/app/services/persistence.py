"""Persistance : tout ce qui se relance seul au démarrage de Windows (lecture seule, sans admin).

Six mécanismes, ceux qu'un attaquant utilise pour survivre à un redémarrage :
  run      clés Run / RunOnce (HKCU, HKLM, WOW6432Node)          ATT&CK T1547.001
  startup  dossiers Démarrage (utilisateur et commun)             T1547.001
  task     tâches planifiées (cachées comprises)                  T1053.005
  service  services à démarrage automatique ou en cours           T1543.003
  driver   pilotes chargés ou chargés au démarrage                T1543.003
  wmi      abonnements d'événements WMI permanents                T1546.003

Chaque entrée est rapportée au fichier RÉELLEMENT exécuté (la DLL d'un `rundll32`, d'un service
`svchost` ou d'un gestionnaire COM, le script d'un `wscript`…) : c'est lui dont on vérifie la
signature, pas l'hôte Microsoft qui le charge.

Référence : au premier balayage tout est « connu » ; ensuite une entrée NOUVELLE ou MODIFIÉE
(commande changée) est signalée, et lève une alerte si son fichier n'est pas signé Microsoft.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import re
import sys
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone

from sqlalchemy import delete, select

from app import notify
from app.db import SessionLocal
from app.models.persistence import PersistenceSeen
from app.services import authenticode
from app.services.alerts import save_alerts

log = logging.getLogger("detectx.persistence")

MECHANISMS = ("run", "startup", "task", "service", "driver", "wmi")
ATTACK = {"run": "T1547.001", "startup": "T1547.001", "task": "T1053.005", "service": "T1543.003", "driver": "T1543.003", "wmi": "T1546.003"}
LABEL = {"run": "Clé Run", "startup": "Dossier Démarrage", "task": "Tâche planifiée", "service": "Service", "driver": "Pilote", "wmi": "Abonnement WMI"}

CACHE_S = 60
SCAN_EVERY_S = 300
MAX_COMMAND = 4096

_SYSTEM_ROOT = os.environ.get("SystemRoot", r"C:\Windows")


# ─────────────────────────────── modèle
@dataclass
class Entry:
    mechanism: str
    name: str
    location: str  # clé de registre, chemin de tâche, dossier… (où agir)
    command: str
    scope: str  # user | machine | system | kernel
    enabled: bool | None = True
    image: str | None = None  # exécutable lancé
    target: str | None = None  # fichier réellement exécuté (celui dont on vérifie la signature)
    account: str | None = None
    detail: str | None = None  # déclencheur, type de démarrage…
    builtin: bool = False  # tâche \Microsoft\, abonnement WMI d'origine
    control: dict | None = field(default=None)  # de quoi la désactiver (remèdes), None = non désactivable

    @property
    def id(self) -> str:
        return entry_id(self.mechanism, self.location, self.name)

    @property
    def fingerprint(self) -> str:
        return fingerprint(self.command)


def entry_id(mechanism: str, location: str, name: str) -> str:
    return hashlib.sha1(f"{mechanism}|{location.lower()}|{name.lower()}".encode()).hexdigest()[:16]


def fingerprint(command: str) -> str:
    return hashlib.sha1(" ".join(command.lower().split()).encode()).hexdigest()[:16]


# ─────────────────────────────── commandes (pur, testé)
_EXEC_EXT = r"(?:exe|com|bat|cmd|dll|sys|scr|cpl|ocx|ps1|vbs|vbe|js|jse|wsf|hta|lnk|msi|jar|py)"
_UNQUOTED = re.compile(rf"^(.+?\.{_EXEC_EXT})(?=$|[\s,])", re.IGNORECASE)
_TOKENS = re.compile(r'"[^"]*"|\S+')
_DLL_HOSTS = {"rundll32.exe", "regsvr32.exe"}
_SCRIPT_HOSTS = {"wscript.exe", "cscript.exe", "mshta.exe"}
_POWERSHELL = {"powershell.exe", "pwsh.exe"}


def expand(path: str, system_root: str | None = None) -> str:
    """Normalise un chemin tel qu'écrit dans le registre (`\\SystemRoot\\…`, `\\??\\C:\\…`,
    `System32\\drivers\\x.sys`, `%ProgramFiles%\\…`)."""
    root = system_root or _SYSTEM_ROOT
    p = path.strip().strip('"')
    p = p.removeprefix("\\??\\")
    low = p.lower()
    if low.startswith("\\systemroot\\"):
        p = root + p[11:]
    elif low.startswith(("system32\\", "syswow64\\")):
        p = root + "\\" + p
    return os.path.expandvars(p)


def split_command(command: str) -> tuple[str | None, str]:
    """« "C:\\a b\\x.exe" -k » → ("C:\\a b\\x.exe", "-k") ; gère les chemins non entre guillemets
    contenant des espaces (`C:\\Program Files\\x.exe /s`) et `rundll32.exe x.dll,Entrée`."""
    c = command.strip()
    if not c:
        return None, ""
    if c.startswith('"'):
        end = c.find('"', 1)
        if end > 1:
            return expand(c[1:end]), c[end + 1 :].strip()
        return expand(c[1:]), ""
    m = _UNQUOTED.match(c)
    if m:
        return expand(m.group(1)), c[m.end() :].strip()
    first, _, rest = c.partition(" ")
    return expand(first), rest.strip()


def payload(image: str | None, args: str) -> str | None:
    """Fichier réellement exécuté quand l'image est un hôte (rundll32, wscript, powershell -File…)."""
    if not image:
        return None
    host = os.path.basename(image).lower()
    tokens = [t.strip('"') for t in _TOKENS.findall(args)]
    plain = [t for t in tokens if not t.startswith(("/", "-"))]
    if host in _DLL_HOSTS and plain:
        return expand(plain[0].split(",")[0])
    if host in _SCRIPT_HOSTS and plain and not re.match(r"^(?:https?|javascript|vbscript):", plain[0], re.IGNORECASE):
        return expand(plain[0])
    if host in _POWERSHELL:
        for i, t in enumerate(tokens[:-1]):
            if t.lower() in ("-file", "-f"):
                return expand(tokens[i + 1])
    if host == "cmd.exe":
        script = next((t for t in plain if re.search(r"\.(?:bat|cmd)$", t, re.IGNORECASE)), None)
        return expand(script) if script else None
    return None


def startup_approved_enabled(data: bytes | None) -> bool:
    """Valeur binaire de `Explorer\\StartupApproved` : 1er octet pair (02, 06) = activé,
    impair (03, 07) = désactivé par l'utilisateur (Gestionnaire des tâches). Absente = activé."""
    if not data:
        return True
    return not (data[0] & 1)


_USER_DIRS = ("\\appdata\\", "\\temp\\", "\\tmp\\", "\\downloads\\", "\\téléchargements\\", "\\users\\public\\", "\\programdata\\")
_SUSPICIOUS_COMMAND = re.compile(
    r"(?:\s-e(?:nc(?:odedcommand)?)?\s|frombase64string|downloadstring|invoke-webrequest|\biwr\b|\biex\b|https?://|mshta|javascript:|vbscript:)",
    re.IGNORECASE,
)


def user_writable(path: str | None) -> bool:
    return bool(path) and any(d in path.lower() for d in _USER_DIRS)


def severity(entry: Entry, verdict: str | None) -> tuple[str, int]:
    """Gravité d'une persistance nouvelle ou modifiée (non signée Microsoft)."""
    if _SUSPICIOUS_COMMAND.search(f" {entry.command} "):
        return "high", 70  # commande encodée / téléchargement : typique d'un implant
    risky = verdict in ("unsigned", "invalid")
    if risky and user_writable(entry.target or entry.image):
        return "high", 70
    if risky or verdict in (None, "unknown"):
        return "medium", 45
    return "low", 20  # éditeur tiers identifié (installation d'un logiciel, le plus souvent)


def finish(entry: Entry) -> Entry:
    """Complète image et cible à partir de la commande."""
    if entry.image is None:
        image, args = split_command(entry.command)
        entry.image = _locate(image)
    else:
        _, args = split_command(entry.command)
    entry.target = entry.target or _locate(payload(entry.image, args)) or entry.image
    entry.command = entry.command[:MAX_COMMAND]
    return entry


def _locate(path: str | None) -> str | None:
    """`rundll32.exe` → C:\\Windows\\System32\\rundll32.exe (comme le ferait Windows)."""
    if not path or os.path.isabs(path) or "\\" in path:
        return path
    for folder in (os.path.join(_SYSTEM_ROOT, "System32"), _SYSTEM_ROOT):
        for name in (path, path + ".exe"):
            candidate = os.path.join(folder, name)
            if os.path.isfile(candidate):
                return candidate
    return path


# ─────────────────────────────── collecte Windows
SUPPORTED = sys.platform == "win32"

_RUN_KEYS = (
    # (ruche, sous-clé, sous-clé StartupApproved correspondante)
    ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\Run", "Run"),
    ("HKCU", r"Software\Microsoft\Windows\CurrentVersion\RunOnce", None),
    ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\Run", "Run"),
    ("HKLM", r"Software\Microsoft\Windows\CurrentVersion\RunOnce", None),
    ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Run", "Run32"),
    ("HKLM", r"Software\WOW6432Node\Microsoft\Windows\CurrentVersion\RunOnce", None),
)
APPROVED = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved"


def _hive(name: str):
    import winreg

    return {"HKCU": winreg.HKEY_CURRENT_USER, "HKCR": winreg.HKEY_CLASSES_ROOT}.get(name, winreg.HKEY_LOCAL_MACHINE)


def _values(hive: str, sub: str) -> list[tuple[str, object, int]]:
    import winreg

    try:
        with winreg.OpenKey(_hive(hive), sub) as k:
            out, i = [], 0
            while True:
                try:
                    out.append(winreg.EnumValue(k, i))
                except OSError:
                    return out
                i += 1
    except OSError:
        return []


def _value(hive: str, sub: str, name: str):
    import winreg

    try:
        with winreg.OpenKey(_hive(hive), sub) as k:
            return winreg.QueryValueEx(k, name)[0]
    except OSError:
        return None


def _run_keys() -> list[Entry]:
    entries = []
    for hive, sub, approved in _RUN_KEYS:
        states = {n.lower(): v for n, v, _ in _values(hive, f"{APPROVED}\\{approved}")} if approved else {}
        for name, value, _ in _values(hive, sub):
            if not name or not isinstance(value, str) or not value.strip():
                continue
            entries.append(
                finish(
                    Entry(
                        "run", name, f"{hive}\\{sub}", value, "user" if hive == "HKCU" else "machine",
                        enabled=startup_approved_enabled(states.get(name.lower())),
                        control={"kind": "startup", "hive": hive, "approved": approved, "name": name} if approved else None,
                    )
                )
            )
    return entries


def _startup_folders(shell) -> list[Entry]:
    folders = (
        ("HKCU", os.path.expandvars(r"%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup")),
        ("HKLM", os.path.expandvars(r"%ProgramData%\Microsoft\Windows\Start Menu\Programs\StartUp")),
    )
    entries = []
    for hive, folder in folders:
        if not os.path.isdir(folder):
            continue
        states = {n.lower(): v for n, v, _ in _values(hive, f"{APPROVED}\\StartupFolder")}
        for file in sorted(os.listdir(folder)):
            path = os.path.join(folder, file)
            if file.lower() == "desktop.ini" or not os.path.isfile(path):
                continue
            command, image = f'"{path}"', path
            if file.lower().endswith(".lnk") and shell is not None:
                try:
                    link = shell.CreateShortcut(path)
                    image = link.TargetPath or path
                    command = f'"{image}" {link.Arguments or ""}'.strip()
                except Exception:  # noqa: BLE001 - raccourci illisible : on garde le fichier lui-même
                    log.debug("raccourci illisible : %s", path)
            entries.append(
                finish(
                    Entry(
                        "startup", file, folder, command, "user" if hive == "HKCU" else "machine",
                        enabled=startup_approved_enabled(states.get(file.lower())),
                        image=image,
                        control={"kind": "startup", "hive": hive, "approved": "StartupFolder", "name": file},
                    )
                )
            )
    return entries


_TRIGGERS = {0: "événement", 1: "date fixe", 2: "chaque jour", 3: "chaque semaine", 4: "chaque mois", 5: "chaque mois", 6: "inactivité", 7: "à la création", 8: "au démarrage", 9: "à l'ouverture de session", 11: "changement de session"}
_SYSTEM_ACCOUNTS = {"system", "s-1-5-18", "local service", "s-1-5-19", "network service", "s-1-5-20", "localsystem", "nt authority\\system"}


def _clsid_dll(clsid: str) -> str | None:
    # HKCR = vue fusionnée HKLM + HKCU (les tâches par utilisateur enregistrent leur CLSID dans HKCU).
    value = _value("HKCR", rf"CLSID\{clsid}\InprocServer32", "")
    return expand(value) if isinstance(value, str) and value else None


def _tasks() -> list[Entry]:
    import win32com.client

    service = win32com.client.Dispatch("Schedule.Service")
    service.Connect()
    entries: list[Entry] = []

    def walk(folder) -> None:
        try:
            tasks = list(folder.GetTasks(1))  # 1 = TASK_ENUM_HIDDEN
        except Exception:  # noqa: BLE001 - dossier refusé : on continue ailleurs
            tasks = []
        for task in tasks:
            try:
                entries.extend(_task_entries(task))
            except Exception:  # noqa: BLE001 - définition illisible sans droits admin
                log.debug("tâche illisible : %s", getattr(task, "Path", "?"))
        try:
            for sub in folder.GetFolders(0):
                walk(sub)
        except Exception:  # noqa: BLE001 - sous-dossiers refusés sans droits admin
            log.debug("dossiers de tâches illisibles sous %s", getattr(folder, "Path", "?"))

    walk(service.GetFolder("\\"))
    return entries


def _task_entries(task) -> list[Entry]:
    definition = task.Definition
    path = task.Path
    principal = definition.Principal
    account = principal.UserId or principal.GroupId or None
    scope = "system" if (account or "").lower() in _SYSTEM_ACCOUNTS else "machine" if principal.RunLevel == 1 else "user"
    triggers = sorted({_TRIGGERS.get(t.Type, "autre") for t in definition.Triggers})
    folder, _, name = path.rpartition("\\")
    out = []
    for i, action in enumerate(definition.Actions):
        if action.Type == 0:  # exécution
            command = f'"{(action.Path or "").strip().strip(chr(34))}" {action.Arguments or ""}'.strip()
            entry = Entry("task", name, folder or "\\", command, scope)
        elif action.Type == 5:  # gestionnaire COM : la DLL du CLSID est le vrai code exécuté
            dll = _clsid_dll(action.ClassId)
            entry = Entry("task", name, folder or "\\", f"COM {action.ClassId}" + (f" ({dll})" if dll else ""), scope, image=dll, target=dll)
            if dll is None:  # CLSID non résolu : rien à analyser comme commande
                entry.enabled, entry.account = bool(task.Enabled), account
                entry.detail, entry.builtin = ", ".join(triggers) or "sans déclencheur", path.lower().startswith("\\microsoft\\")
                entry.control = {"kind": "task", "path": path}
                out.append(entry)
                continue
        else:
            continue  # courriel / message : obsolètes, sans effet
        if i:
            entry.name = f"{name} (action {i + 1})"
        entry.enabled = bool(task.Enabled)
        entry.account = account
        entry.detail = ", ".join(triggers) or "sans déclencheur"
        entry.builtin = path.lower().startswith("\\microsoft\\")
        entry.control = {"kind": "task", "path": path}
        out.append(finish(entry))
    return out


_START = {0: "au démarrage du noyau", 1: "à l'initialisation du système", 2: "automatique", 3: "manuel", 4: "désactivé"}


def _services_and_drivers() -> list[Entry]:
    import winreg

    import win32service

    manager = win32service.OpenSCManager(None, None, win32service.SC_MANAGER_ENUMERATE_SERVICE)
    try:
        active = {s[0].lower() for s in win32service.EnumServicesStatus(manager, win32service.SERVICE_WIN32 | win32service.SERVICE_DRIVER, win32service.SERVICE_ACTIVE)}
    finally:
        win32service.CloseServiceHandle(manager)

    root = r"SYSTEM\CurrentControlSet\Services"
    entries: list[Entry] = []
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, root) as services:
        for i in range(winreg.QueryInfoKey(services)[0]):
            try:
                name = winreg.EnumKey(services, i)
            except OSError:
                continue
            values = {n.lower(): v for n, v, _ in _values("HKLM", f"{root}\\{name}")}
            kind, start, image_path = values.get("type"), values.get("start"), values.get("imagepath")
            if not isinstance(kind, int) or not isinstance(start, int) or not isinstance(image_path, str):
                continue
            running = name.lower() in active
            if kind & 0x40:  # modèles et instances de services par utilisateur : copies des modèles Windows
                continue
            if kind & 0x3:
                if not (running or start <= 2):
                    continue
                mechanism, scope, image, command = "driver", "kernel", expand(image_path), image_path
            elif kind & 0x30:
                # TOUS les services, quel que soit leur démarrage : un service « à la demande » qui
                # tourne par intermittence ne doit pas apparaître/disparaître (fausses nouveautés),
                # et un service désactivé (par exemple depuis DeTecTX) doit rester réactivable.
                mechanism, scope, command = "service", "system", image_path
                image = None
            else:
                continue
            dll = _value("HKLM", f"{root}\\{name}\\Parameters", "ServiceDll") if mechanism == "service" else None
            delayed = values.get("delayedautostart") == 1
            entry = Entry(
                mechanism, name, f"HKLM\\{root}", command, scope,
                enabled=start != 4,
                image=image,
                target=expand(dll) if isinstance(dll, str) and dll else None,
                account=values.get("objectname") if isinstance(values.get("objectname"), str) else None,
                detail=_START.get(start, str(start)) + (" (différé)" if delayed else "") + (" · en cours" if running else ""),
                control={"kind": "service", "name": name, "start": start, "delayed": delayed} if mechanism == "service" else None,
            )
            entries.append(finish(entry))
    return entries


def _wmi() -> list[Entry]:
    import win32com.client

    locator = win32com.client.Dispatch("WbemScripting.SWbemLocator")
    svc = locator.ConnectServer(".", "root\\subscription")
    consumers = {}
    for cls in ("CommandLineEventConsumer", "ActiveScriptEventConsumer", "NTEventLogEventConsumer", "LogFileEventConsumer", "SMTPEventConsumer"):
        try:
            for c in svc.ExecQuery(f"SELECT * FROM {cls}"):
                consumers[f"{cls}.{c.Name}".lower()] = (cls, c)
        except Exception:  # noqa: BLE001 - classe absente sur ce poste
            log.debug("classe WMI %s illisible", cls)
    entries = []
    for binding in svc.ExecQuery("SELECT * FROM __FilterToConsumerBinding"):
        consumer_path, filter_path = str(binding.Consumer), str(binding.Filter)
        m = re.search(r'(\w+EventConsumer)\.Name="([^"]*)"', consumer_path)
        f = re.search(r'Name="([^"]*)"', filter_path)
        if not m:
            continue
        cls, cname = m.group(1), m.group(2)
        found = consumers.get(f"{cls}.{cname}".lower())
        command, image = f"{cls} « {cname} »", None
        if found and cls == "CommandLineEventConsumer":
            c = found[1]
            command = c.CommandLineTemplate or c.ExecutablePath or command
        elif found and cls == "ActiveScriptEventConsumer":
            c = found[1]
            command = f"script {c.ScriptingEngine}: " + (c.ScriptFileName or (c.ScriptText or "")[:400])
            image = c.ScriptFileName or None
        builtin = cls == "NTEventLogEventConsumer" and cname == "SCM Event Log Consumer"  # présent d'origine sur Windows
        entry = Entry("wmi", cname, f"root\\subscription · filtre « {f.group(1) if f else '?'} »", command, "system", image=image, builtin=builtin)
        entries.append(finish(entry) if cls == "CommandLineEventConsumer" else entry)
    return entries


def collect() -> tuple[list[Entry], dict[str, str]]:
    """Inventaire complet (bloquant, ~1 s) : entrées + erreurs par mécanisme."""
    if not SUPPORTED:
        return [], {m: "disponible uniquement sous Windows" for m in MECHANISMS}
    import pythoncom

    pythoncom.CoInitialize()
    try:
        return _collect_all()  # objets COM tous libérés au retour, AVANT CoUninitialize
    finally:
        pythoncom.CoUninitialize()


def _collect_all() -> tuple[list[Entry], dict[str, str]]:
    import win32com.client

    try:
        shell = win32com.client.Dispatch("WScript.Shell")
    except Exception:  # noqa: BLE001
        shell = None
    sources = {
        "run": _run_keys,
        "startup": lambda: _startup_folders(shell),
        "task": _tasks,
        "service+driver": _services_and_drivers,
        "wmi": _wmi,
    }
    entries: list[Entry] = []
    errors: dict[str, str] = {}
    for key, source in sources.items():
        try:
            entries.extend(source())
        except Exception as e:  # noqa: BLE001 - un mécanisme illisible n'empêche pas les autres
            log.warning("persistance %s illisible : %s", key, e)
            for m in key.split("+"):
                errors[m] = "lecture impossible"
    return entries, errors


# ─────────────────────────────── référence + alertes
def _signature(entry: Entry) -> dict | None:
    sig = authenticode.cached(entry.target)
    return sig.as_dict() if sig else None


def _alert(entry: Entry, status: str, now: datetime) -> dict:
    sig = authenticode.verify(entry.target)  # peu d'entrées nouvelles : vérification immédiate
    level, score = severity(entry, sig.verdict)
    who = f"signé {sig.publisher}" if sig.publisher else {"unsigned": "NON signé", "invalid": "signature invalide"}.get(sig.verdict, "signature non vérifiable")
    what = "Nouvelle persistance" if status == "new" else "Persistance modifiée"
    return {
        "dedup_key": f"persistence:{entry.id}:{entry.fingerprint}",
        "rule_id": "persistence-new",
        "rule_title": f"{what} : {LABEL[entry.mechanism].lower()} « {entry.name} »"[:255],
        "severity": level,
        "risk_score": score,
        "mitre": ATTACK[entry.mechanism],
        "channel": "DeTecTX/Persistance",
        "event_id": None,
        "event_record_id": None,
        "event_timestamp": now,
        "message": (
            f"{what} ({LABEL[entry.mechanism]}, portée {entry.scope}) : {entry.name}\n"
            f"Emplacement : {entry.location}\nCommande : {entry.command}\n"
            f"Fichier exécuté : {entry.target or '—'} ({who})"
        )[:4000],
    }


async def reconcile(entries: list[Entry], *, now: datetime | None = None) -> tuple[dict[str, PersistenceSeen], list[dict]]:
    """Compare l'inventaire à la référence : insère, marque nouveau/modifié, lève les alertes."""
    now = now or datetime.now(timezone.utc)
    async with SessionLocal() as session:
        rows = {r.id: r for r in (await session.scalars(select(PersistenceSeen))).all()}
        has_baseline = bool(rows)
        changed: list[tuple[Entry, str]] = []
        seen: set[str] = set()
        for e in entries:
            if e.id in seen:
                continue
            seen.add(e.id)
            row = rows.get(e.id)
            if row is None:
                status = "new" if has_baseline else "baseline"
                row = PersistenceSeen(id=e.id, mechanism=e.mechanism, name=e.name[:512], fingerprint=e.fingerprint, status=status, first_seen=now, last_seen=now, changed_at=now if has_baseline else None)
                session.add(row)
                rows[e.id] = row
                if has_baseline:
                    changed.append((e, "new"))
            else:
                row.last_seen = now
                if row.fingerprint != e.fingerprint:
                    row.fingerprint = e.fingerprint
                    row.status = "modified" if row.status == "baseline" else row.status
                    row.changed_at = now
                    changed.append((e, "modified"))
        # Disparues : GARDÉES dans la référence (last_seen ne bouge plus). Un pilote chargé à
        # l'insertion d'un périphérique, un mécanisme illisible le temps d'un balayage : leur
        # retour n'est pas une nouveauté. Un changement de commande reste, lui, détecté.
        await session.commit()

    candidates = []
    for e, status in changed:
        sig = await asyncio.to_thread(authenticode.verify, e.target)
        if sig.verdict == "microsoft":
            continue  # mise à jour de Windows : journal d'activité seulement
        candidates.append(await asyncio.to_thread(_alert, e, status, now))
    created: list[dict] = []
    if candidates:
        async with SessionLocal() as session:
            created = await save_alerts(session, candidates)
        if created and notify.enabled():
            try:
                await notify.notify_alerts(created)
            except Exception:
                log.warning("notification des alertes de persistance impossible", exc_info=True)
    return rows, created


_state: dict = {"at": 0.0, "snapshot": None}
_lock = asyncio.Lock()


async def scan(force: bool = False) -> dict:
    """Inventaire rapproché de la référence, mis en cache 60 s."""
    async with _lock:
        if not force and _state["snapshot"] is not None and time.monotonic() - _state["at"] < CACHE_S:
            return _state["snapshot"]
        entries, errors = await asyncio.to_thread(collect)
        rows, created = await reconcile(entries)
        authenticode.schedule(e.target for e in entries)
        _state["entries"] = {e.id: e for e in entries}
        _state["snapshot"] = _build(entries, errors, rows, len(created))
        _state["at"] = time.monotonic()
        return _state["snapshot"]


def _build(entries: list[Entry], errors: dict[str, str], rows: dict[str, PersistenceSeen], alerts: int) -> dict:
    items = []
    for e in entries:
        row = rows.get(e.id)
        d = asdict(e)
        d.update(
            id=e.id,
            attack=ATTACK[e.mechanism],
            status=row.status if row else "baseline",
            first_seen=row.first_seen.isoformat() if row else None,
            changed_at=row.changed_at.isoformat() if row and row.changed_at else None,
            can_disable=e.control is not None,
        )
        items.append(d)
    baseline_at = min((r.first_seen for r in rows.values()), default=None)
    return {
        "scanned_at": datetime.now(timezone.utc).isoformat(),
        "baseline_at": baseline_at.isoformat() if baseline_at else None,
        "entries": items,
        "errors": errors,
        "alerts_raised": alerts,
    }


def with_signatures(snapshot: dict) -> dict:
    """Ajoute les signatures déjà calculées (non bloquant) ; les autres arrivent aux relevés suivants."""
    entries = []
    pending = []
    for d in snapshot["entries"]:
        sig = authenticode.cached(d["target"])
        if sig is None and d["target"]:
            pending.append(d["target"])
        entries.append({**d, "signature": sig.as_dict() if sig else None})
    authenticode.schedule(pending)
    return {**snapshot, "entries": entries, "signatures_pending": len(pending)}


def current(entry_id_: str) -> Entry | None:
    """Entrée de l'inventaire courant (les remèdes n'acceptent QUE des ids de l'inventaire)."""
    return (_state.get("entries") or {}).get(entry_id_)


async def approve(entry_id_: str) -> bool:
    """Marque une entrée nouvelle/modifiée comme vérifiée (elle rejoint la référence)."""
    async with SessionLocal() as session:
        row = await session.get(PersistenceSeen, entry_id_)
        if row is None:
            return False
        row.status = "baseline"
        await session.commit()
    _state["at"] = 0.0
    return True


async def reset_baseline() -> None:
    """Nouvelle référence : tout ce qui est présent maintenant devient « connu »."""
    async with SessionLocal() as session:
        await session.execute(delete(PersistenceSeen))
        await session.commit()
    _state["at"] = 0.0


def invalidate() -> None:
    _state["at"] = 0.0


async def run_forever() -> None:
    """Surveillance continue : balayage toutes les 5 minutes (les nouveautés lèvent des alertes)."""
    await asyncio.sleep(20)
    while True:
        try:
            await scan(force=True)
        except Exception:
            log.exception("balayage de persistance")
        await asyncio.sleep(SCAN_EVERY_S)
