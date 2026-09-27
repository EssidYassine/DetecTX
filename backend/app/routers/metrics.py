"""Endpoints métriques système (santé, réseau, gestion des processus).

Les handlers sont synchrones (`def`) : psutil et l'attente d'arrêt d'un processus sont
bloquants, FastAPI les exécute dans son pool de threads au lieu de figer la boucle asyncio.
"""

import logging
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.services import firewall
from app.services import metrics as svc

router = APIRouter(prefix="/metrics", tags=["metrics"])
audit_log = logging.getLogger("detectx.audit")

Pid = Annotated[int, Path(ge=1, le=2**31 - 1)]


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
