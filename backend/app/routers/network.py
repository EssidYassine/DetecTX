"""Sonar : réseau local (inventaire, scans à la demande, référence).

Droits : tout utilisateur connecté lit ; analyste et admin scannent, renomment, approuvent ;
seul l'admin accepte une nouvelle box (ce qui désarme l'alerte d'usurpation) ou repart d'une
nouvelle référence. Chaque action est inscrite au journal d'audit.
"""

import logging
import time
from collections import deque
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.network import inventory, service, sonar
from app.network.neighbors import Observation
from app.schemas.network import (
    DEVICE_ID_PATTERN,
    DeviceUpdate,
    GatewayAccept,
    ScanRequest,
)

router = APIRouter(prefix="/network", tags=["network"])
audit_log = logging.getLogger("detectx.audit")

DeviceIdPath = Annotated[str, Path(pattern=DEVICE_ID_PATTERN)]

SCAN_LIMIT = 2  # scans à la demande par utilisateur…
SCAN_WINDOW_S = 60.0  # …et par minute
_scan_calls: dict[str, deque[float]] = {}


def _rate_check(user: str, now: float) -> None:
    q = _scan_calls.setdefault(user, deque())
    while q and now - q[0] > SCAN_WINDOW_S:
        q.popleft()
    if len(q) >= SCAN_LIMIT:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="Trop de scans demandés : réessayez dans une minute.")


async def _online() -> Observation:
    obs = await sonar.current()
    if obs is None:
        raise HTTPException(status_code=503, detail="Hors ligne : aucun réseau local.")
    return obs


def _key(obs: Observation) -> str:
    return service.network_key(obs)


@router.get("/status")
async def network_status(_: User = Depends(get_current_user)) -> dict:
    obs = await sonar.current()
    return {**sonar.status(obs), "scans": await inventory.scans(10)}


@router.get("/devices")
async def network_devices(_: User = Depends(get_current_user)) -> dict:
    obs = await _online()
    found = await inventory.devices(_key(obs))
    return found or {"network": None, "devices": []}  # réseau pas encore observé (1re minute)


@router.get("/devices/{device_id}")
async def network_device(device_id: DeviceIdPath, _: User = Depends(get_current_user)) -> dict:
    found = await inventory.device(_key(await _online()), device_id)
    if found is None:
        raise HTTPException(status_code=404, detail="Appareil inconnu sur le réseau actuel.")
    return found


@router.patch("/devices/{device_id}")
async def network_device_update(device_id: DeviceIdPath, body: DeviceUpdate, user: User = Depends(require_role(Role.admin, Role.analyst))) -> dict:
    key = _key(await _online())
    set_label = "label" in body.model_fields_set
    if not await inventory.update(key, device_id, label=body.label, set_label=set_label, approve=body.approve):
        raise HTTPException(status_code=404, detail="Appareil inconnu sur le réseau actuel.")
    audit_log.info("network_device_update actor=%s device=%s label=%r approve=%s", user.email, device_id, body.label if set_label else "<inchangé>", body.approve)
    return await inventory.device(key, device_id)


@router.post("/scan", status_code=status.HTTP_202_ACCEPTED)
async def network_scan(body: ScanRequest, user: User = Depends(require_role(Role.admin, Role.analyst))) -> dict:
    """Lance un scan en tâche de fond ; l'avancement se lit dans /network/status (« running »)."""
    now = time.monotonic()
    _rate_check(user.email, now)
    obs = await _online()
    device_ip = None
    if body.device_id is not None:
        device_ip = await inventory.find_ip(_key(obs), body.device_id)
        if device_ip is None:
            raise HTTPException(status_code=404, detail="Appareil inconnu sur le réseau actuel.")
    try:
        running = await sonar.launch(obs, body.profile, user.email, device_ip)
    except sonar.Refused as e:
        audit_log.warning("network_scan actor=%s profile=%s target=%s refused=%s", user.email, body.profile, device_ip or obs.interface.network, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    _scan_calls[user.email].append(now)  # seuls les scans réellement lancés comptent
    audit_log.info("network_scan actor=%s profile=%s target=%s", user.email, body.profile, running["target"])
    return running


@router.get("/scans")
async def network_scans(_: User = Depends(get_current_user)) -> list[dict]:
    return await inventory.scans(20)


@router.post("/gateway/accept")
async def network_gateway_accept(body: GatewayAccept, user: User = Depends(require_role(Role.admin))) -> dict:
    """La box a été remplacée : l'appareil qui répond pour la passerelle devient la référence."""
    key = _key(await _online())
    previous = await inventory.accept_gateway(key, body.device_id)
    if previous is None:
        raise HTTPException(status_code=409, detail="Cet appareil ne répond pas pour la passerelle, ou c'est déjà la box de référence.")
    audit_log.warning("network_gateway_accept actor=%s device=%s previous_mac=%s", user.email, body.device_id, previous)
    return await inventory.device(key, body.device_id)


@router.post("/baseline")
async def network_baseline(user: User = Depends(require_role(Role.admin))) -> dict:
    """Nouvelle référence : le réseau actuel est oublié et réappris (période d'apprentissage comprise)."""
    obs = await _online()
    if not await inventory.reset(_key(obs)):
        raise HTTPException(status_code=404, detail="Réseau pas encore observé.")
    audit_log.warning("network_baseline_reset actor=%s network=%s", user.email, obs.interface.network)
    await service.reconcile(obs)  # référence immédiate, sans attendre le cycle suivant
    return await inventory.devices(_key(obs))
