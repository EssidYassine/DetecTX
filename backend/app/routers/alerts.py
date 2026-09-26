"""Endpoints des alertes produites par le moteur de détection."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models.user import User
from app.schemas.alerts import AlertPage, AlertStats
from app.services import alerts as svc

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=AlertPage)
async def list_alerts(
    severity: str | None = Query(default=None),
    status: str | None = Query(default=None),
    mitre: str | None = Query(default=None),
    q: str | None = Query(default=None),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> AlertPage:
    return await svc.list_alerts(
        session, severity=severity, status=status, mitre=mitre, q=q, offset=offset, limit=limit
    )


@router.get("/stats", response_model=AlertStats)
async def stats(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> AlertStats:
    return await svc.alerts_stats(session)
