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
    "blocked": None,  # raison pour laquelle la couche active ne tourne pas
    "error": None,  # dernier échec d'un scan actif
}


def _due(last: float | None, every_s: float) -> bool:
    return last is None or time.monotonic() - last >= every_s


async def cycle() -> None:
    obs = await asyncio.to_thread(neighbors.observe)
    if obs is None:
        return  # hors ligne, ou hors Windows
    await service.reconcile(obs)
    nmap = nmap_runner.find_nmap(settings.nmap_path)
    await active.enrich(service.network_key(obs), [], nmap)  # fabricant des appareils vus en passif
    _state["blocked"] = active.block_reason(enabled=settings.network_active_scan, nmap=nmap, categories=obs.categories)
    if _state["blocked"] or nmap is None:
        return
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


def status() -> dict:
    nmap = nmap_runner.find_nmap(settings.nmap_path)
    return {
        "nmap": str(nmap) if nmap else None,
        "raw_packets": active.raw_available(),
        "blocked": _state["blocked"],
        "error": _state["error"],
        "last_discovery": _state["last_discovery"],
        "last_ports": _state["last_ports"],
    }


async def run_forever() -> None:
    await asyncio.sleep(15)
    while True:
        try:
            await cycle()
        except Exception:
            log.exception("surveillance du réseau local")
        await asyncio.sleep(PASSIVE_EVERY_S)
