"""Endpoints notifications (Discord)."""

from fastapi import APIRouter, Depends

from app import notify
from app.deps import get_current_user, require_role
from app.models.user import Role, User

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("/status")
async def status_(_: User = Depends(get_current_user)) -> dict:
    return {"discord": notify.enabled()}


@router.post("/test")
async def test(_: User = Depends(require_role(Role.admin, Role.analyst))) -> dict:
    if not notify.enabled():
        return {"sent": False, "detail": "Aucun webhook Discord configuré (DISCORD_WEBHOOK_URL)."}
    ok = await notify.send_test()
    return {"sent": ok, "detail": "Message envoyé." if ok else "Échec de l'envoi."}
