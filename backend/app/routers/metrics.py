"""Endpoints métriques système (santé + gestion des processus)."""

import logging

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.services import metrics as svc

router = APIRouter(prefix="/metrics", tags=["metrics"])
audit_log = logging.getLogger("detectx.audit")


@router.get("/current")
async def current(_: User = Depends(get_current_user)) -> dict:
    return svc.snapshot()


@router.get("/processes")
async def processes(
    limit: int = Query(default=40, ge=1, le=200),
    _: User = Depends(get_current_user),
) -> list[dict]:
    return svc.top_processes(limit)


@router.post("/processes/{pid}/kill")
async def kill(
    pid: int = Path(ge=1, le=2**31 - 1),
    user: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    # Action destructive sur le poste : tracée qu'elle réussisse ou non.
    try:
        result = svc.kill_process(pid)
    except svc.KillError as e:
        audit_log.warning("process_kill actor=%s pid=%s refused=%s", user.email, pid, e.status)
        raise HTTPException(status_code=e.status, detail=e.detail)
    audit_log.info("process_kill actor=%s pid=%s name=%s", user.email, pid, result.get("name"))
    return result
