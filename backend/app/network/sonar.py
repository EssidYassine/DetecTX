"""Sonar : la boucle de surveillance du réseau local.

Chaque minute : table ARP (couche passive). Puis, si le réseau le permet (voir
active.block_reason) : découverte Nmap toutes les NETWORK_DISCOVERY_MINUTES, scan des ports
courants toutes les NETWORK_PORTS_HOURS. Un échec n'arrête jamais la boucle ; il est
gardé dans l'état (`status()`) pour être affiché à l'utilisateur.
"""

from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone

from app.config import get_settings
from app.network import active, neighbors, nmap_runner, service
from app.network.nmap_runner import ScanError
from app.network.target import TargetRefused

log = logging.getLogger("detectx.network")
settings = get_settings()

PASSIVE_EVERY_S = 60

_state: dict = {
    "discovery_at": None,  # time.monotonic() du dernier essai
    "ports_at": None,
    "last_discovery": None,  # datetime UTC de la dernière réussite
    "last_ports": None,
    "error": None,  # dernier échec d'un scan actif
    "running": None,  # {"profile", "target", "actor", "started_at"} pendant un scan à la demande
}
_tasks: set[asyncio.Task] = set()  # référence forte : une tâche non référencée peut être ramassée


class Refused(Exception):
    """Scan à la demande refusé : `status` HTTP et message pour l'utilisateur."""

    def __init__(self, status: int, detail: str):
        self.status = status
        self.detail = detail


def _due(last: float | None, every_s: float) -> bool:
    return last is None or time.monotonic() - last >= every_s


async def cycle() -> None:
    obs = await asyncio.to_thread(neighbors.observe)
    if obs is None:
        return  # hors ligne, ou hors Windows
    await service.reconcile(obs)
    nmap = nmap_runner.find_nmap(settings.nmap_path)
    await active.enrich(service.network_key(obs), [], nmap)  # fabricant des appareils vus en passif
    blocked = active.block_reason(enabled=settings.network_active_scan, nmap=nmap, categories=obs.categories)
    if blocked or nmap is None or _state["running"] is not None:
        return  # un scan à la demande occupe Nmap : les scans planifiés attendent le cycle suivant
    try:
        if _due(_state["discovery_at"], settings.network_discovery_minutes * 60):
            _state["discovery_at"] = time.monotonic()
            await active.discovery(obs, nmap)
            _state["last_discovery"] = datetime.now(timezone.utc)
        if settings.network_ports_hours and _due(_state["ports_at"], settings.network_ports_hours * 3600):
            _state["ports_at"] = time.monotonic()
            await active.port_scan(obs, nmap)
            _state["last_ports"] = datetime.now(timezone.utc)
        _state["error"] = None
    except (ScanError, TargetRefused) as e:
        _state["error"] = str(e)
        log.warning("Sonar, scan actif : %s", e)


async def current() -> neighbors.Observation | None:
    """Observation fraîche (la catégorie du réseau a pu changer depuis le dernier cycle)."""
    return await asyncio.to_thread(neighbors.observe)


def status(obs: neighbors.Observation | None) -> dict:
    nmap = nmap_runner.find_nmap(settings.nmap_path)
    blocked = active.block_reason(enabled=settings.network_active_scan, nmap=nmap, categories=obs.categories) if obs else "Hors ligne : aucune route par défaut."
    return {
        "online": obs is not None,
        "network": None
        if obs is None
        else {
            "key": service.network_key(obs),
            "name": service.network_label(obs),
            "subnet": obs.interface.network,
            "gateway": obs.interface.gateway,
            "local_ip": obs.interface.ip,
            "categories": list(obs.categories),
        },
        "nmap_installed": nmap is not None,
        "raw_packets": active.raw_available(),
        "active_blocked": blocked,
        "error": _state["error"],
        "running": _state["running"],
        "last_discovery": _state["last_discovery"],
        "last_ports": _state["last_ports"],
        "schedule": {"passive_s": PASSIVE_EVERY_S, "discovery_min": settings.network_discovery_minutes, "ports_h": settings.network_ports_hours},
    }


async def launch(obs: neighbors.Observation, profile: str, actor: str, device_ip: str | None = None) -> dict:
    """Lance un scan à la demande EN TÂCHE DE FOND (l'analyse approfondie dure jusqu'à 3 min)."""
    nmap = nmap_runner.find_nmap(settings.nmap_path)
    reason = active.block_reason(enabled=settings.network_active_scan, nmap=nmap, categories=obs.categories)
    if reason or nmap is None:
        raise Refused(409, reason or "Nmap introuvable.")
    if _state["running"] is not None or nmap_runner._busy.locked():
        raise Refused(409, "Un scan est déjà en cours : réessayez dans un instant.")
    if profile == "deep" and device_ip is None:
        raise Refused(422, "L'analyse approfondie porte sur un appareil de l'inventaire.")
    scope = device_ip or obs.interface.network
    _state["running"] = {"profile": profile, "target": scope, "actor": actor, "started_at": datetime.now(timezone.utc)}

    async def job() -> None:
        try:
            if profile == "discovery":
                await active.discovery(obs, nmap, actor)
                _state["last_discovery"] = datetime.now(timezone.utc)
            elif profile == "ports":
                await active.port_scan(obs, nmap, actor)
                _state["last_ports"] = datetime.now(timezone.utc)
            else:
                await active.deep_scan(obs, nmap, device_ip, actor)
            _state["error"] = None
        except (ScanError, TargetRefused) as e:
            _state["error"] = str(e)
            log.warning("Sonar, scan à la demande (%s) : %s", profile, e)
        except Exception:
            _state["error"] = "Échec inattendu du scan (voir le journal du backend)."
            log.exception("Sonar, scan à la demande (%s)", profile)
        finally:
            _state["running"] = None

    task = asyncio.create_task(job())
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return dict(_state["running"])


async def run_forever() -> None:
    await asyncio.sleep(15)
    while True:
        try:
            await cycle()
        except Exception:
            log.exception("surveillance du réseau local")
        await asyncio.sleep(PASSIVE_EVERY_S)
