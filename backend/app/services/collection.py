"""Santé de la collecte : l'agent tourne-t-il, chaque journal remonte-t-il, Sysmon est-il là ?

Sans ce suivi, un collecteur arrêté est invisible : le dashboard affiche simplement « rien »,
ce qui ressemble à « rien ne s'est passé ». Trois signaux :
- battement de cœur de l'agent (chaque envoi, même vide) — gardé en mémoire : après un
  redémarrage du backend il revient au prochain cycle de l'agent (quelques secondes) ;
- dernier événement reçu par journal (lu dans le stockage) ;
- présence du service Sysmon sur l'hôte (le backend tourne sur la machine surveillée).
"""

import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psutil

EXPECTED = (
    ("Security", "Sécurité"),
    ("System", "Système"),
    ("Application", "Applications"),
    ("Microsoft-Windows-PowerShell/Operational", "PowerShell"),
    ("Microsoft-Windows-Sysmon/Operational", "Sysmon"),
    ("DeTecTX-FileMonitor", "Fichiers surveillés"),
)
SYSMON_SERVICES = ("Sysmon64", "Sysmon")


@dataclass
class Heartbeat:
    computer: str
    last_seen: datetime
    version: str | None = None
    admin: bool | None = None
    interval_sec: int | None = None


_beats: dict[str, Heartbeat] = {}
_lock = threading.Lock()


def record(computer: str, *, version: str | None, admin: bool | None, interval_sec: int | None, now: datetime | None = None) -> None:
    with _lock:
        _beats[computer] = Heartbeat(computer, now or datetime.now(timezone.utc), version, admin, interval_sec)


def latest_heartbeat() -> Heartbeat | None:
    with _lock:
        return max(_beats.values(), key=lambda b: b.last_seen, default=None)


def sysmon_status() -> dict:
    if sys.platform != "win32":
        return {"installed": False, "running": False, "service": None}
    for name in SYSMON_SERVICES:
        try:
            svc = psutil.win_service_get(name)
            return {"installed": True, "running": svc.status() == "running", "service": name}
        except (psutil.NoSuchProcess, OSError):
            continue
    return {"installed": False, "running": False, "service": None}


def _alive(beat: Heartbeat | None, now: datetime) -> bool:
    if beat is None:
        return False
    window = max(60, 3 * (beat.interval_sec or 15))
    return now - beat.last_seen <= timedelta(seconds=window)


def assess(
    channels: dict[str, tuple[datetime | None, int]],
    beat: Heartbeat | None,
    sysmon: dict,
    now: datetime | None = None,
) -> dict:
    """channels : journal -> (dernier événement, nombre sur 24 h). Pure, testable."""
    now = now or datetime.now(timezone.utc)
    alive = _alive(beat, now)
    rows = []
    for channel, label in EXPECTED:
        last, count = channels.get(channel, (None, 0))
        hint = None
        sysmon_absent = "Sysmon" in channel and not sysmon["installed"]
        if sysmon_absent:  # d'anciens événements ne disent rien de l'état actuel
            status = "missing"
            hint = "Sysmon n'est pas installé : processus, réseau et registre ne sont pas tracés."
        elif last is None:
            status = "missing"
            if "Sysmon" in channel:
                hint = "Sysmon n'est pas installé." if not sysmon["installed"] else "Sysmon est installé mais aucun événement n'est arrivé."
            elif channel == "Security":
                hint = "L'agent doit tourner en administrateur pour lire ce journal."
        elif now - last <= timedelta(hours=24):
            status = "ok"
        elif alive:
            status = "quiet"  # l'agent tourne ; ce journal est simplement calme
        else:
            status = "stale"
        rows.append({"channel": channel, "label": label, "last_event": last, "count_24h": count, "status": status, "hint": hint})
    # Journaux non attendus mais présents (ex. fichiers .log centralisés).
    for channel, (last, count) in channels.items():
        if channel not in dict(EXPECTED):
            rows.append({"channel": channel, "label": channel, "last_event": last, "count_24h": count, "status": "ok" if last and now - last <= timedelta(hours=24) else "quiet", "hint": None})

    last_event = max((r["last_event"] for r in rows if r["last_event"]), default=None)
    if not alive:
        status = "down"
        since = beat.last_seen if beat else last_event
        summary = f"Collecte arrêtée{_since(since, now)} : lancez l'agent DeTecTX." if since else "Aucun agent de collecte ne s'est encore connecté."
    elif (beat is not None and beat.admin is False) or not sysmon["running"]:
        status = "degraded"
        gaps = []
        if beat and beat.admin is False:
            gaps.append("agent sans droits administrateur (journal Sécurité non lu)")
        if not sysmon["running"]:
            gaps.append("Sysmon absent (processus, réseau, registre non tracés)")
        summary = "Collecte partielle : " + " ; ".join(gaps) + "."
    else:
        status, summary = "ok", "Collecte complète et à jour."
    return {
        "status": status,
        "summary": summary,
        "agent": {
            "alive": alive,
            "computer": beat.computer if beat else None,
            "last_seen": beat.last_seen if beat else None,
            "version": beat.version if beat else None,
            "admin": beat.admin if beat else None,
            "interval_sec": beat.interval_sec if beat else None,
        },
        "sysmon": sysmon,
        "channels": rows,
        "last_event": last_event,
    }


def _since(then: datetime | None, now: datetime) -> str:
    if then is None:
        return ""
    minutes = int((now - then).total_seconds() // 60)
    if minutes < 60:
        return f" depuis {minutes} min"
    hours = minutes // 60
    return f" depuis {hours} h" if hours < 48 else f" depuis {hours // 24} jours"
