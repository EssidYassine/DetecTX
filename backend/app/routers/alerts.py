"""Endpoints des alertes produites par le moteur de détection (lecture + triage)."""

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.models.alert import Alert
from app.models.user import Role, User
from app.schemas.alerts import (
    AlertOut,
    AlertPage,
    AlertStats,
    AlertTimeline,
    BulkTriage,
    BulkTriageResult,
    TriageUpdate,
)
from app.services import alerts as svc

router = APIRouter(prefix="/alerts", tags=["alerts"])


@router.get("", response_model=AlertPage)
async def list_alerts(
    severity: str | None = Query(default=None),
    status: str | None = Query(default=None),
    mitre: str | None = Query(default=None),
    q: str | None = Query(default=None),
    since: datetime | None = Query(default=None, description="Début de période (ISO 8601, inclus)"),
    until: datetime | None = Query(default=None, description="Fin de période (ISO 8601, exclue)"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> AlertPage:
    return await svc.list_alerts(
        session,
        severity=severity,
        status=status,
        mitre=mitre,
        q=q,
        since=since,
        until=until,
        offset=offset,
        limit=limit,
    )


@router.get("/stats", response_model=AlertStats)
async def stats(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> AlertStats:
    return await svc.alerts_stats(session)


@router.get("/timeline", response_model=AlertTimeline)
async def timeline(
    days: int = Query(default=30, ge=1, le=90),
    tz_offset: int = Query(default=0, ge=-840, le=840, description="Décalage local sur UTC, en minutes"),
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> AlertTimeline:
    return await svc.alerts_timeline(session, days=days, tz_offset_min=tz_offset)


@router.post("/triage", response_model=BulkTriageResult)
async def bulk_triage(
    payload: BulkTriage,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(require_role(Role.admin, Role.analyst)),
) -> BulkTriageResult:
    """Triage groupé (200 alertes max). L'auteur est l'utilisateur authentifié."""
    return await svc.triage_alerts(
        session, payload.ids, status=payload.status, resolution=payload.resolution, actor=user.email
    )


@router.patch("/{alert_id}", response_model=AlertOut)
async def triage_one(
    alert_id: int,
    payload: TriageUpdate,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(require_role(Role.admin, Role.analyst)),
) -> Alert:
    result = await svc.triage_alerts(
        session, [alert_id], status=payload.status, resolution=payload.resolution, actor=user.email
    )
    if result.updated == 0:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Alerte introuvable")
    alert = await session.get(Alert, alert_id)
    await session.refresh(alert)  # recharge après commit (session asynchrone)
    return alert
