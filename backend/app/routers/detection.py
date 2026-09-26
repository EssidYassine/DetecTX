"""Endpoints du moteur de détection : règles et exécution."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.detection import engine
from app.models.user import Role, User
from app.schemas.alerts import DetectionRunResult, RuleInfo
from app.services import alerts as svc

router = APIRouter(prefix="/detection", tags=["detection"])


@router.get("/rules", response_model=list[RuleInfo])
async def list_rules(_: User = Depends(get_current_user)) -> list[RuleInfo]:
    """Liste les règles de détection chargées."""
    return [
        RuleInfo(
            id=r.id, title=r.title, severity=r.level, mitre=r.mitre, description=r.description
        )
        for r in engine.load_rules()
    ]


@router.post("/run", response_model=DetectionRunResult)
async def run(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> DetectionRunResult:
    """Exécute toutes les règles sur les événements et crée les nouvelles alertes."""
    return await svc.run_detection(session)
