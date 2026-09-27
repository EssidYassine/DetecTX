"""Métriques système de l'hôte (via psutil) — le backend tourne sur la machine surveillée."""

import os
import socket
import time
from datetime import datetime, timezone

import psutil

# PID protégés : System Idle, System, et le backend lui-même.
_PROTECTED = {0, 4, os.getpid()}

_last_net = None
_last_ts = None

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


_PROC_ATTRS = ["pid", "name", "memory_percent", "cpu_percent", "memory_info", "username", "exe", "status", "create_time"]


def top_processes(n: int = 8) -> list[dict]:
    """Processus les plus gourmands en mémoire, avec les détails utiles à l'analyse :
    chemin de l'exécutable (un binaire système lancé hors de System32 est suspect),
    utilisateur, statut, date de démarrage. Les champs refusés par l'OS valent None."""
    procs = []
    for p in psutil.process_iter(_PROC_ATTRS, ad_value=None):
        info = p.info
        # PID 0 (« System Idle Process ») : son « CPU » est le temps d'inactivité, pas une charge.
        if info.get("pid") == 0:
            continue
        mem = info.get("memory_info")
        started = info.get("create_time")
        procs.append(
            {
                "pid": info.get("pid"),
                "name": info.get("name"),
                "memory_percent": round(info.get("memory_percent") or 0.0, 1),
                "cpu_percent": round(info.get("cpu_percent") or 0.0, 1),
                "rss": mem.rss if mem else None,
                "username": info.get("username"),
                "exe": info.get("exe") or None,
                "status": info.get("status"),
                "started_at": datetime.fromtimestamp(started, timezone.utc).isoformat() if started else None,
            }
        )
    procs.sort(key=lambda x: x["memory_percent"], reverse=True)
    return procs[:n]


class KillError(Exception):
    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


def kill_process(pid: int) -> dict:
    """Termine un processus (action initiée par l'utilisateur). PID sensibles protégés."""
    if pid in _PROTECTED:
        raise KillError(400, "Processus protégé — arrêt refusé.")
    try:
        p = psutil.Process(pid)
        name = p.name()
        p.terminate()
        try:
            p.wait(timeout=3)
        except psutil.TimeoutExpired:
            p.kill()
        return {"killed": True, "pid": pid, "name": name}
    except psutil.NoSuchProcess:
        raise KillError(404, "Processus introuvable (déjà terminé ?).")
    except psutil.AccessDenied:
        raise KillError(403, "Accès refusé — relancez DeTecTX en administrateur pour ce processus.")
