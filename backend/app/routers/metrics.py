"""Endpoints métriques système (santé + gestion des processus)."""

from fastapi import APIRouter, Depends, HTTPException, Query

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.services import metrics as svc

router = APIRouter(prefix="/metrics", tags=["metrics"])


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
    pid: int,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    try:
        return svc.kill_process(pid)
    except svc.KillError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)
