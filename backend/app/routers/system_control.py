"""Endpoints de contrôle système (démarrage, raccourcis, localisation) — user-level."""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.services import syscontrol as svc

router = APIRouter(prefix="/system", tags=["system"])


class StartupToggle(BaseModel):
    name: str
    enable: bool


class ShortcutIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1)
    args: str = ""
    workdir: str = ""


class LocationIn(BaseModel):
    allowed: bool


@router.get("/startup")
async def startup(_: User = Depends(get_current_user)) -> list[dict]:
    return svc.list_startup()


@router.post("/startup/toggle")
async def startup_toggle(
    payload: StartupToggle,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    try:
        return svc.set_startup_enabled(payload.name, payload.enable)
    except svc.SysError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.post("/shortcut")
async def shortcut(
    payload: ShortcutIn,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    try:
        return svc.create_shortcut(payload.name, payload.target, payload.args, payload.workdir)
    except svc.SysError as e:
        raise HTTPException(status_code=e.status, detail=e.detail)


@router.get("/location")
async def location(_: User = Depends(get_current_user)) -> dict:
    return svc.get_location()


@router.post("/location")
async def set_location(
    payload: LocationIn,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    return svc.set_location(payload.allowed)
