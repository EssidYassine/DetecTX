"""Métriques système de l'hôte (via psutil) — le backend tourne sur la machine surveillée."""

import ipaddress
import os
import socket
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone

import psutil

from app.services import authenticode, winproc

# PID protégés : System Idle, System, et le backend lui-même.
_PROTECTED = {0, 4, os.getpid()}

# Processus critiques de Windows : les tuer fait planter ou redémarrer la machine. Protégés
# seulement s'ils sont les vrais (dans System32, ou chemin illisible = processus système) :
# un « lsass.exe » lancé depuis AppData reste arrêtable, c'est justement un leurre à abattre.
_CRITICAL_NAMES = {
    "smss.exe", "csrss.exe", "wininit.exe", "winlogon.exe", "services.exe", "lsass.exe",
    "svchost.exe", "registry", "memcompression", "memory compression",
}
_SYSTEM32 = os.path.normcase(os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32"))

_last_net = None
_last_ts = None
# psutil.process_iter partage un cache global : on sérialise les énumérations concurrentes.
_iter_lock = threading.Lock()

# Amorce les compteurs % CPU (le 1er appel psutil renvoie 0). psutil suit séparément
# l'état global et l'état par cœur : il faut amorcer les deux.
psutil.cpu_percent(interval=None)
psutil.cpu_percent(interval=None, percpu=True)


def snapshot() -> dict:
    cpu = psutil.cpu_percent(interval=None)
    per_core = psutil.cpu_percent(interval=None, percpu=True)
    vm = psutil.virtual_memory()

    disks = []
    for part in psutil.disk_partitions(all=False):
        if "cdrom" in part.opts or part.fstype == "":
            continue
        try:
            u = psutil.disk_usage(part.mountpoint)
            disks.append(
                {"mount": part.device, "total": u.total, "used": u.used, "percent": u.percent}
            )
        except (PermissionError, OSError):
            continue

    net = psutil.net_io_counters()
    now = time.time()
    up = down = 0.0
    global _last_net, _last_ts
    if _last_net is not None and _last_ts is not None:
        dt = now - _last_ts
        if dt > 0:
            up = max(0.0, (net.bytes_sent - _last_net.bytes_sent) / dt)
            down = max(0.0, (net.bytes_recv - _last_net.bytes_recv) / dt)
    _last_net, _last_ts = net, now

    return {
        "hostname": socket.gethostname(),
        "cpu_percent": round(cpu, 1),
        "cpu_per_core": [round(c, 1) for c in per_core],
        "cpu_count": psutil.cpu_count(logical=True) or 1,
        "ram_percent": vm.percent,
        "ram_used": vm.used,
        "ram_total": vm.total,
        "disks": disks,
        "net_up": round(up, 1),
        "net_down": round(down, 1),
        "uptime_seconds": int(now - psutil.boot_time()),
        "process_count": len(psutil.pids()),
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


_PROC_ATTRS = [
    "pid", "ppid", "name", "memory_percent", "cpu_percent", "memory_info",
    "username", "exe", "status", "create_time", "cmdline",
]

# Chemin natif Windows : taux CPU / E/S calculés par différence entre deux instantanés.
_MIN_WINDOW = 1.0  # s : fenêtre minimale de mesure (plusieurs clients peuvent interroger)
# (pid, create_time) -> (cpu_s, io_bytes, instant de la mesure) : horodatage PAR processus,
# pour qu'un processus apparu entre deux fenêtres ait quand même sa référence.
_baseline: dict[tuple, tuple[float, int, float]] = {}
_identity: dict[tuple, tuple[str | None, str | None, str | None]] = {}  # (pid, create_time) -> (exe, user, cmdline)
MAX_CMDLINE = 4096


def _proc_identity(pid: int, key: tuple) -> tuple[str | None, str | None, str | None]:
    """Chemin, utilisateur et ligne de commande : immuables pour une instance de processus, donc
    mis en cache. Ligne de commande None = refusée (processus protégé, sans droits admin)."""
    cached = _identity.get(key)
    if cached is not None:
        return cached
    exe = user = cmdline = None
    try:
        proc = psutil.Process(pid)
        try:
            path = proc.exe()
            # Les pseudo-processus (« MemCompression »…) renvoient un nom, pas un chemin.
            exe = path if path and ("\\" in path or "/" in path) else None
        except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
            pass
        try:
            user = proc.username()
        except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
            pass
        try:
            args = proc.cmdline()
            cmdline = subprocess.list2cmdline(args)[:MAX_CMDLINE] if args else None
        except (psutil.AccessDenied, psutil.ZombieProcess, OSError):
            pass
    except psutil.NoSuchProcess:
        pass
    _identity[key] = (exe, user, cmdline)
    return exe, user, cmdline


def _with_signatures(procs: list[dict]) -> list[dict]:
    """Signature de l'exécutable (déjà calculée, sinon demandée en tâche de fond : jamais bloquant)."""
    missing = []
    for p in procs:
        sig = authenticode.cached(p["exe"])
        if sig is None and p["exe"]:
            missing.append(p["exe"])
        p["signature"] = sig.as_dict() if sig else None
    authenticode.schedule(missing)
    return procs


def _native_processes() -> list[dict]:
    raw = winproc.snapshot()
    now = time.monotonic()
    total_mem = psutil.virtual_memory().total or 1
    windows = _app_windows()
    seen: set[tuple] = set()
    procs = []
    for r in raw:
        if r.pid == 0:  # « System Idle Process » : son CPU est l'inactivité, pas une charge
            continue
        key = (r.pid, r.create_time)
        seen.add(key)
        prev = _baseline.get(key)
        cpu = io = 0.0
        if prev is None:
            _baseline[key] = (r.cpu_seconds, r.io_bytes, now)  # 1re observation : taux au prochain appel
        elif (window := now - prev[2]) > 0:
            cpu = max(0.0, (r.cpu_seconds - prev[0]) / window * 100)  # % d'UN cœur, comme psutil
            io = max(0.0, (r.io_bytes - prev[1]) / window)
            # Référence renouvelée seulement si la fenêtre est assez longue : deux clients qui
            # interrogent à 50 ms d'écart ne doivent pas produire des taux bruités.
            if window >= _MIN_WINDOW:
                _baseline[key] = (r.cpu_seconds, r.io_bytes, now)
        exe, user, cmdline = _proc_identity(r.pid, key)
        procs.append(
            {
                "pid": r.pid,
                "ppid": r.ppid,
                "name": r.name or None,
                "memory_percent": round(r.rss / total_mem * 100, 1),
                "cpu_percent": round(cpu, 1),
                "rss": r.rss,
                "io_bps": round(io),
                "threads": r.threads,
                "windows": len(windows.get(r.pid, ())),
                "username": user,
                "exe": exe,
                "cmdline": cmdline,
                "status": "stopped" if r.suspended else "running",
                "started_at": datetime.fromtimestamp(r.create_time, timezone.utc).isoformat() if r.create_time else None,
            }
        )
    for cache in (_baseline, _identity):  # processus disparus
        for key in [k for k in cache if k not in seen]:
            del cache[key]
    return procs


def _psutil_processes() -> list[dict]:
    """Repli portable (hors Windows x64) : plus lent, un appel par processus."""
    procs = []
    for p in psutil.process_iter(_PROC_ATTRS, ad_value=None):
        info = p.info
        if info.get("pid") == 0:
            continue
        mem = info.get("memory_info")
        started = info.get("create_time")
        procs.append(
            {
                "pid": info.get("pid"),
                "ppid": info.get("ppid"),
                "name": info.get("name"),
                "memory_percent": round(info.get("memory_percent") or 0.0, 1),
                "cpu_percent": round(info.get("cpu_percent") or 0.0, 1),
                "rss": mem.rss if mem else None,
                "io_bps": None,
                "threads": None,
                "windows": None,
                "username": info.get("username"),
                "exe": info.get("exe") or None,
                "cmdline": subprocess.list2cmdline(info["cmdline"])[:MAX_CMDLINE] if info.get("cmdline") else None,
                "status": info.get("status"),
                "started_at": datetime.fromtimestamp(started, timezone.utc).isoformat() if started else None,
            }
        )
    return procs


def top_processes(n: int = 8) -> list[dict]:
    """Processus les plus gourmands en mémoire, avec les détails utiles à l'analyse :
    parent (arborescence), chemin de l'exécutable (un binaire système lancé hors de System32
    est suspect), utilisateur, statut, date de démarrage, débit d'E/S. Champs refusés = None."""
    with _iter_lock:
        procs = _native_processes() if winproc.SUPPORTED else _psutil_processes()
    procs.sort(key=lambda x: x["memory_percent"], reverse=True)
    return _with_signatures(procs[:n])


# ─────────────────────────────── réseau
def _scope(ip: str) -> str:
    """loopback | private (LAN, lien local) | public | other (multicast, non spécifiée…)."""
    try:
        addr = ipaddress.ip_address(ip.split("%", 1)[0])  # retire l'identifiant de zone IPv6
    except ValueError:
        return "other"
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped:
        addr = addr.ipv4_mapped
    if addr.is_loopback:
        return "loopback"
    if addr.is_multicast or addr.is_unspecified or addr.is_reserved:
        return "other"
    if addr.is_private or addr.is_link_local:
        return "private"
    return "public"


def connections(limit: int = 500) -> dict:
    """Sockets réseau de l'hôte, rattachés à leur processus.

    - listening : ports en écoute (TCP LISTEN, UDP sans pair). « exposed » = joignable depuis
      le réseau (liaison sur toutes les interfaces ou une IP non loopback).
    - connections : connexions TCP avec un pair distant (hors échanges locaux loopback).
    """
    try:
        socks = psutil.net_connections(kind="inet")
    except psutil.AccessDenied as e:  # pas le cas sous Windows ; possible sur d'autres OS
        raise KillError(403, "Accès refusé à la table des connexions.") from e
    with _iter_lock:
        names = {p.pid: p.info["name"] for p in psutil.process_iter(["name"], ad_value=None)}

    listening: dict[tuple, dict] = {}
    conns: list[dict] = []
    loopback = 0
    for s in socks:
        proto = "tcp" if s.type == socket.SOCK_STREAM else "udp"
        if not s.laddr:
            continue
        lip, lport = s.laddr.ip, s.laddr.port
        pid = s.pid or None
        if (proto == "tcp" and s.status == psutil.CONN_LISTEN) or (proto == "udp" and not s.raddr):
            listening[(proto, lip, lport, pid)] = {
                "proto": proto,
                "ip": lip,
                "port": lport,
                "pid": pid,
                "process": names.get(pid) if pid else None,
                "exposed": _scope(lip) != "loopback",
            }
            continue
        if not s.raddr:
            continue
        scope = _scope(s.raddr.ip)
        if scope == "loopback":
            loopback += 1  # IPC locale (navigateurs, IDE…) : comptée, pas listée
            continue
        conns.append(
            {
                "proto": proto,
                "lip": lip,
                "lport": lport,
                "rip": s.raddr.ip,
                "rport": s.raddr.port,
                "status": s.status if proto == "tcp" else "NONE",
                "pid": pid,
                "process": names.get(pid) if pid else None,
                "scope": scope,
            }
        )
    conns.sort(key=lambda c: (c["status"] != psutil.CONN_ESTABLISHED, c["process"] or "", c["rip"]))
    return {
        "listening": sorted(listening.values(), key=lambda x: (not x["exposed"], x["port"])),
        "connections": conns[:limit],
        "truncated": max(0, len(conns) - limit),
        "loopback": loopback,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }


# ─────────────────────────────── arrêt de processus
class KillError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


def _is_critical(p: psutil.Process) -> bool:
    try:
        name = (p.name() or "").lower()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return False
    if name not in _CRITICAL_NAMES:
        return False
    try:
        exe = p.exe()
    except (psutil.AccessDenied, psutil.ZombieProcess):
        return True  # chemin illisible pour un nom critique : on présume le vrai
    except psutil.NoSuchProcess:
        return False
    return not exe or os.path.normcase(os.path.dirname(exe)) == _SYSTEM32


def _guard(p: psutil.Process) -> None:
    """Refuse l'arrêt d'un processus protégé (lève KillError 400)."""
    if p.pid == os.getpid():
        raise KillError(400, "Cette action arrêterait DeTecTX lui-même : refusée.")
    if p.pid in _PROTECTED:
        raise KillError(400, "Processus protégé — arrêt refusé.")
    if _is_critical(p):
        raise KillError(400, f"« {p.name()} » est un processus critique de Windows : l'arrêter ferait planter le système.")


def _safe_name(p: psutil.Process) -> str | None:
    try:
        return p.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return None


def _kill_plan(pid: int, tree: bool) -> list[psutil.Process]:
    """Processus à arrêter (la cible d'abord, puis ses descendants), tous vérifiés AVANT
    d'agir : une arborescence qui contient un processus protégé est refusée en bloc."""
    try:
        target = psutil.Process(pid)
        plan = [target] + (target.children(recursive=True) if tree else [])
    except psutil.NoSuchProcess:
        raise KillError(404, "Processus introuvable (déjà terminé ?).")
    for p in plan:
        _guard(p)
    return plan


def kill_process(pid: int, tree: bool = False) -> dict:
    """Arrêt forcé (TerminateProcess sous Windows) : immédiat, sans que le programme puisse
    enregistrer. Avec tree=True, ses sous-processus aussi (utile contre un malware qui relance
    ses enfants). La cible est tuée en premier pour qu'elle ne relance pas ses enfants."""
    plan = _kill_plan(pid, tree)
    target = plan[0]
    name = _safe_name(target)
    try:
        target.kill()
    except psutil.NoSuchProcess:
        raise KillError(404, "Processus introuvable (déjà terminé ?).")
    except psutil.AccessDenied:
        raise KillError(403, "Accès refusé — relancez DeTecTX en administrateur pour ce processus.")

    killed = [{"pid": target.pid, "name": name}]
    failed = []
    for child in plan[1:]:
        child_name = _safe_name(child)
        try:
            child.kill()
            killed.append({"pid": child.pid, "name": child_name})
        except psutil.NoSuchProcess:
            killed.append({"pid": child.pid, "name": child_name})  # parti entre-temps
        except psutil.AccessDenied:
            failed.append({"pid": child.pid, "name": child_name, "reason": "accès refusé"})
    psutil.wait_procs(plan, timeout=3)
    return {"killed": True, "pid": pid, "name": name, "tree": killed, "failed": failed}


# Fermeture propre (Windows) : WM_CLOSE aux fenêtres principales du processus, comme la croix
# de la fenêtre ou « taskkill » sans /F. Le programme peut proposer d'enregistrer ou refuser.
_WM_CLOSE = 0x0010
_GW_OWNER = 4
_GWL_EXSTYLE = -20
_WS_EX_TOOLWINDOW = 0x00000080
_DWMWA_CLOAKED = 14


def _user32():
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
    return user32


def _app_windows() -> dict[int, list]:
    """Fenêtres « d'application » par PID, en un seul passage : visibles, de premier niveau,
    sans propriétaire, titrées, hors barres d'outils et hors fenêtres masquées par DWM (apps
    UWP suspendues). Ce sont les fenêtres de la barre des tâches — celles qu'on peut fermer.

    Ne voit que le bureau de la session du backend : DeTecTX doit tourner dans la session de
    l'utilisateur (pas en service Windows) pour voir et fermer ses fenêtres."""
    if sys.platform != "win32":
        return {}
    import ctypes
    from ctypes import wintypes

    user32 = _user32()
    dwmapi = ctypes.WinDLL("dwmapi")
    dwmapi.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
    found: dict[int, list] = {}

    def on_window(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd) or user32.GetWindow(hwnd, _GW_OWNER):
            return True
        if user32.GetWindowLongW(hwnd, _GWL_EXSTYLE) & _WS_EX_TOOLWINDOW or not user32.GetWindowTextLengthW(hwnd):
            return True
        cloaked = wintypes.DWORD(0)
        dwmapi.DwmGetWindowAttribute(hwnd, _DWMWA_CLOAKED, ctypes.byref(cloaked), ctypes.sizeof(cloaked))
        if cloaked.value:
            return True
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        found.setdefault(owner.value, []).append(hwnd)
        return True

    callback = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)(on_window)
    user32.EnumWindows(callback, 0)
    return found


def _main_windows(pid: int) -> list:
    return _app_windows().get(pid, [])


def close_process(pid: int, wait: float = 3.0) -> dict:
    """Demande polie de fermeture. `exited` = le processus a quitté dans le délai ; sinon il
    attend sans doute une réponse de l'utilisateur (« Enregistrer les modifications ? »)."""
    if sys.platform != "win32":
        raise KillError(501, "Fermeture propre disponible uniquement sous Windows.")
    target = _kill_plan(pid, tree=False)[0]
    name = _safe_name(target)
    windows = _main_windows(pid)
    if not windows:
        raise KillError(
            409,
            "Ce processus n'a pas de fenêtre : dans une application multi-processus (navigateur, "
            "Electron…), la fenêtre appartient au processus principal.",
        )
    user32 = _user32()
    posted = sum(1 for hwnd in windows if user32.PostMessageW(hwnd, _WM_CLOSE, 0, 0))
    if posted == 0:
        raise KillError(403, "Windows refuse la demande de fermeture (programme lancé en administrateur ?).")
    try:
        target.wait(timeout=wait)
        exited = True
    except psutil.TimeoutExpired:
        exited = False
    return {"pid": pid, "name": name, "windows": posted, "exited": exited}
