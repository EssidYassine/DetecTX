"""Endpoints métriques système (santé, réseau, gestion des processus).

Les handlers sont synchrones (`def`) : psutil et l'attente d'arrêt d'un processus sont
bloquants, FastAPI les exécute dans son pool de threads au lieu de figer la boucle asyncio.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query
from pydantic import BaseModel

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.schemas.firewall import BlockRequest, UnblockRequest
from app.services import firewall, firewall_actions, hardening, persistence, remedies
from app.services import metrics as svc
from app.services.elevation import ActionError

router = APIRouter(prefix="/metrics", tags=["metrics"])
audit_log = logging.getLogger("detectx.audit")

Pid = Annotated[int, Path(ge=1, le=2**31 - 1)]
EntryId = Annotated[str, Path(pattern=r"^[0-9a-f]{16}$")]
FixId = Annotated[str, Path(pattern=r"^[a-z0-9-]{1,32}$")]
RecordId = Annotated[str, Path(pattern=r"^[0-9a-f]{12}$")]


class PersistenceState(BaseModel):
    enabled: bool


@router.get("/current")
def current(_: User = Depends(get_current_user)) -> dict:
    return svc.snapshot()


@router.get("/processes")
def processes(
    limit: int = Query(default=40, ge=1, le=2000),
    _: User = Depends(get_current_user),
) -> list[dict]:
    return svc.top_processes(limit)


@router.get("/connections")
def connections(_: User = Depends(get_current_user)) -> dict:
    try:
        return svc.connections()
    except svc.KillError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.get("/exposure")
def exposure(_: User = Depends(get_current_user)) -> dict:
    """Ports en écoute × règles du pare-feu Windows : ce qui est réellement joignable, et le risque."""
    return firewall.exposure()


@router.post("/processes/{pid}/kill")
def kill(
    pid: Pid,
    tree: bool = Query(default=False, description="Arrêter aussi tous les sous-processus"),
    user: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    # Action destructive sur le poste : tracée qu'elle réussisse ou non.
    try:
        result = svc.kill_process(pid, tree=tree)
    except svc.KillError as e:
        audit_log.warning("process_kill actor=%s pid=%s tree=%s refused=%s", user.email, pid, tree, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info(
        "process_kill actor=%s pid=%s name=%s tree=%s killed=%s failed=%s",
        user.email, pid, result.get("name"), tree,
        [p["pid"] for p in result["tree"]], [p["pid"] for p in result["failed"]],
    )
    return result


@router.post("/processes/{pid}/close")
def close(
    pid: Pid,
    user: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    try:
        result = svc.close_process(pid)
    except svc.KillError as e:
        audit_log.warning("process_close actor=%s pid=%s refused=%s", user.email, pid, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info(
        "process_close actor=%s pid=%s name=%s windows=%s exited=%s",
        user.email, pid, result["name"], result["windows"], result["exited"],
    )
    return result


# ─────────────────────────────── pare-feu (phase B) : admin DeTecTX + invite UAC Windows
@router.post("/firewall/block")
def firewall_block(body: BlockRequest, user: User = Depends(require_role(Role.admin))) -> dict:
    """Bloque l'entrant sur des ports (règles du groupe DeTecTX). Une seule invite UAC s'affiche."""
    targets = [(t.proto, t.port) for t in body.targets]
    try:
        result = firewall_actions.block(targets, list(body.profiles))
    except firewall_actions.ActionError as e:
        audit_log.warning("firewall_block actor=%s targets=%s profiles=%s refused=%s", user.email, targets, body.profiles, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info("firewall_block actor=%s targets=%s profiles=%s rules=%s", user.email, targets, body.profiles, result["rules"])
    return result


@router.post("/firewall/unblock")
def firewall_unblock(body: UnblockRequest, user: User = Depends(require_role(Role.admin))) -> dict:
    """Retire une règle de blocage DeTecTX (et seulement une règle DeTecTX)."""
    try:
        result = firewall_actions.unblock(body.name)
    except firewall_actions.ActionError as e:
        audit_log.warning("firewall_unblock actor=%s rule=%r refused=%s", user.email, body.name, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info("firewall_unblock actor=%s rule=%r", user.email, body.name)
    return result


# ─────────────────────────────── persistance (ce qui se relance au démarrage)
@router.get("/persistence")
async def persistence_inventory(_: User = Depends(get_current_user)) -> dict:
    """Clés Run, dossier Démarrage, tâches, services, pilotes, WMI — rapprochés de la référence."""
    return persistence.with_signatures(await persistence.scan())


@router.post("/persistence/baseline")
async def persistence_baseline(user: User = Depends(require_role(Role.admin))) -> dict:
    """Nouvelle référence : tout ce qui est présent maintenant devient « connu »."""
    await persistence.reset_baseline()
    audit_log.info("persistence_baseline_reset actor=%s", user.email)
    return persistence.with_signatures(await persistence.scan(force=True))


@router.post("/persistence/{entry_id}/approve")
async def persistence_approve(entry_id: EntryId, user: User = Depends(require_role(Role.admin, Role.analyst))) -> dict:
    """Entrée nouvelle ou modifiée vérifiée par un analyste : elle rejoint la référence."""
    if not await persistence.approve(entry_id):
        raise HTTPException(status_code=404, detail="Entrée inconnue de la référence.")
    audit_log.info("persistence_approve actor=%s entry=%s", user.email, entry_id)
    return {"ok": True}


@router.post("/persistence/{entry_id}/state")
def persistence_state(entry_id: EntryId, body: PersistenceState, user: User = Depends(require_role(Role.admin))) -> dict:
    """Active / désactive une persistance au démarrage (réversible, jamais de suppression)."""
    try:
        result = remedies.set_persistence(entry_id, body.enabled, user.email)
    except ActionError as e:
        audit_log.warning("persistence_state actor=%s entry=%s enabled=%s refused=%s", user.email, entry_id, body.enabled, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info("persistence_state actor=%s entry=%s enabled=%s already=%s", user.email, entry_id, body.enabled, result["already"])
    return result


# ─────────────────────────────── durcissement + remèdes
@router.get("/hardening")
def hardening_state(_: User = Depends(get_current_user)) -> dict:
    """Contrôles de durcissement (lecture seule), avec le remède ou le lien de correction de chacun."""
    return {**hardening.snapshot(), "remedies": remedies.catalog()}


@router.get("/remedies")
def remedies_history(_: User = Depends(get_current_user)) -> dict:
    return {"catalog": remedies.catalog(), "history": list(reversed(remedies.history()))[:50]}


@router.post("/remedies/{fix_id}")
def remedy_apply(fix_id: FixId, user: User = Depends(require_role(Role.admin))) -> dict:
    """Applique une correction du catalogue fermé (invite UAC de Windows, puis vérification)."""
    try:
        result = remedies.apply(fix_id, user.email)
    except ActionError as e:
        audit_log.warning("remedy_apply actor=%s fix=%s refused=%s", user.email, fix_id, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info("remedy_apply actor=%s fix=%s already=%s record=%s", user.email, fix_id, result["already"], (result["record"] or {}).get("id"))
    return result


@router.post("/remedies/history/{record_id}/revert")
def remedy_revert(record_id: RecordId, user: User = Depends(require_role(Role.admin))) -> dict:
    """Annule une correction : la valeur précédente, gardée au journal, est restaurée."""
    try:
        result = remedies.revert(record_id, user.email)
    except ActionError as e:
        audit_log.warning("remedy_revert actor=%s record=%s refused=%s", user.email, record_id, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info("remedy_revert actor=%s record=%s", user.email, record_id)
    return result
