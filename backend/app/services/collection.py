"""Santé de la collecte : les collecteurs tournent-ils, chaque journal remonte-t-il, Sysmon est-il là ?

Sans ce suivi, une collecte arrêtée est invisible : le dashboard affiche « rien », ce qui
ressemble à « rien ne s'est passé ». Signaux :
- battements de cœur des collecteurs (collecteur intégré au backend, agent PowerShell) —
  en mémoire : après un redémarrage du backend ils reviennent au cycle suivant ;
- lisibilité de chaque journal vue par le collecteur intégré (accès refusé, journal absent) ;
- dernier événement reçu par journal (lu dans le stockage) ;
- présence du service Sysmon sur l'hôte (le backend tourne sur la machine surveillée).
"""

import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import psutil

SECURITY = "Security"
SYSMON = "Microsoft-Windows-Sysmon/Operational"

# Journaux suivis (libellé lisible), dans l'ordre d'affichage.
EXPECTED = (
    (SECURITY, "Sécurité"),
    ("Microsoft-Windows-TerminalServices-LocalSessionManager/Operational", "Sessions"),
    ("Microsoft-Windows-Windows Defender/Operational", "Defender"),
    ("Microsoft-Windows-Windows Firewall With Advanced Security/Firewall", "Pare-feu"),
    ("Microsoft-Windows-CodeIntegrity/Operational", "Intégrité du code"),
    ("Microsoft-Windows-PowerShell/Operational", "PowerShell (scripts)"),
    ("Windows PowerShell", "PowerShell (sessions)"),
    (SYSMON, "Sysmon"),
    ("Microsoft-Windows-WMI-Activity/Operational", "WMI"),
    ("Microsoft-Windows-TaskScheduler/Operational", "Tâches planifiées"),
    ("Microsoft-Windows-WLAN-AutoConfig/Operational", "Wi-Fi"),
    ("Microsoft-Windows-NetworkProfile/Operational", "Réseaux"),
    ("Microsoft-Windows-Kernel-PnP/Configuration", "Périphériques"),
    ("Microsoft-Windows-Bits-Client/Operational", "Transferts BITS"),
    ("System", "Système"),
    ("Application", "Applications"),
    ("DeTecTX-FileMonitor", "Fichiers surveillés"),
)
LABELS = dict(EXPECTED)
SYSMON_SERVICES = ("Sysmon64", "Sysmon")
KIND_LABEL = {"integre": "Collecteur intégré", "agent": "Agent PowerShell"}


@dataclass
class Heartbeat:
    computer: str
    kind: str  # « integre » (backend) | « agent » (PowerShell)
    last_seen: datetime
    version: str | None = None
    admin: bool | None = None
    interval_sec: int | None = None


_beats: dict[tuple[str, str], Heartbeat] = {}
_lock = threading.Lock()


def record(
    computer: str,
    *,
    kind: str = "agent",
    version: str | None = None,
    admin: bool | None = None,
    interval_sec: int | None = None,
    now: datetime | None = None,
) -> None:
    with _lock:
        _beats[(computer, kind)] = Heartbeat(computer, kind, now or datetime.now(timezone.utc), version, admin, interval_sec)


def heartbeats() -> list[Heartbeat]:
    with _lock:
        return sorted(_beats.values(), key=lambda b: b.last_seen, reverse=True)


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


def _alive(beat: Heartbeat, now: datetime) -> bool:
    window = max(60, 3 * (beat.interval_sec or 15))
    return now - beat.last_seen <= timedelta(seconds=window)


def _since(then: datetime | None, now: datetime) -> str:
    if then is None:
        return ""
    minutes = int((now - then).total_seconds() // 60)
    if minutes < 60:
        return f" depuis {minutes} min"
    hours = minutes // 60
    return f" depuis {hours} h" if hours < 48 else f" depuis {hours // 24} jours"


def _channel_row(channel, label, last, count, *, readable, sysmon, admin_collector, alive, now) -> dict:
    hint = None
    if channel == SYSMON and not sysmon["installed"]:
        status, hint = "missing", "Sysmon n'est pas installé : processus, réseau et registre ne sont pas tracés."
    elif channel == SECURITY and not admin_collector and (last is None or now - last > timedelta(hours=24)):
        status, hint = "missing", "Lecture réservée aux administrateurs : lancez l'agent en administrateur."
    elif readable == "denied":
        status, hint = "missing", "Accès refusé à ce journal."
    elif readable == "absent" and last is None:
        status, hint = "missing", "Journal absent ou désactivé sur ce poste."
    elif last is None:
        status = "quiet" if alive else "missing"
    elif now - last <= timedelta(hours=24):
        status = "ok"
    elif alive:
        status = "quiet"  # un collecteur tourne ; ce journal est simplement calme
    else:
        status = "stale"
    return {"channel": channel, "label": label, "last_event": last, "count_24h": count, "status": status, "hint": hint}


def assess(
    channels: dict[str, tuple[datetime | None, int]],
    beats: list[Heartbeat],
    sysmon: dict,
    readable: dict[str, str] | None = None,
    now: datetime | None = None,
) -> dict:
    """channels : journal -> (dernier événement, nombre sur 24 h). Pure, testable."""
    now = now or datetime.now(timezone.utc)
    readable = readable or {}
    alive_beats = [b for b in beats if _alive(b, now)]
    alive = bool(alive_beats)
    admin_collector = any(b.admin for b in alive_beats)

    rows = [
        _channel_row(ch, label, *channels.get(ch, (None, 0)), readable=readable.get(ch), sysmon=sysmon, admin_collector=admin_collector, alive=alive, now=now)
        for ch, label in EXPECTED
    ]
    for ch, (last, count) in channels.items():  # journaux présents mais non attendus (.log centralisés…)
        if ch not in LABELS:
            rows.append(_channel_row(ch, ch, last, count, readable=None, sysmon=sysmon, admin_collector=admin_collector, alive=alive, now=now))

    last_event = max((r["last_event"] for r in rows if r["last_event"]), default=None)
    if not alive:
        status = "down"
        since = max([b.last_seen for b in beats] + ([last_event] if last_event else []), default=None)
        summary = f"Collecte arrêtée{_since(since, now)} : aucun collecteur actif." if since else "Aucun collecteur ne s'est encore signalé."
    else:
        gaps = []
        if not admin_collector:
            gaps.append("journal Sécurité non lu (droits administrateur requis)")
        if not sysmon["running"]:
            gaps.append("Sysmon absent (processus, réseau, registre non tracés)")
        status = "degraded" if gaps else "ok"
        summary = ("Collecte active, partielle : " + " ; ".join(gaps) + ".") if gaps else "Collecte complète et à jour."
    return {
        "status": status,
        "summary": summary,
        "collectors": [
            {
                "kind": b.kind,
                "label": KIND_LABEL.get(b.kind, b.kind),
                "computer": b.computer,
                "alive": _alive(b, now),
                "last_seen": b.last_seen,
                "version": b.version,
                "admin": b.admin,
                "interval_sec": b.interval_sec,
            }
            for b in beats
        ],
        "sysmon": sysmon,
        "channels": rows,
        "last_event": last_event,
    }
