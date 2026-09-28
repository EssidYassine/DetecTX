"""Endpoints des alertes produites par le moteur de détection (lecture + triage)."""

from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.models.alert import Alert
from app.models.user import Role, User
from app.schemas.alerts import (
    RULE_ID_PATTERN,
    AlertOut,
    AlertPage,
    AlertStats,
    AlertTimeline,
    BulkTriage,
    BulkTriageResult,
    CasePage,
    CaseTriage,
    TriageUpdate,
)
from app.services import alerts as svc

router = APIRouter(prefix="/alerts", tags=["alerts"])

Severity = Literal["critical", "high", "medium", "low"]
StatusFilter = Literal["new", "ack", "closed", "open"]  # open = nouvelles + en cours


@router.get("", response_model=AlertPage)
async def list_alerts(
    severity: Severity | None = Query(default=None),
    status: StatusFilter | None = Query(default=None),
    mitre: str | None = Query(default=None, max_length=40),
    q: str | None = Query(default=None, max_length=200),
    since: datetime | None = Query(default=None, description="Début de période (ISO 8601, inclus)"),
    until: datetime | None = Query(default=None, description="Fin de période (ISO 8601, exclue)"),
    rule_id: str | None = Query(default=None, pattern=RULE_ID_PATTERN, description="Alertes d'un dossier (règle)"),
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
        rule_id=rule_id,
        offset=offset,
        limit=limit,
    )


@router.get("/cases", response_model=CasePage)
async def list_cases(
    severity: Severity | None = Query(default=None),
    status: StatusFilter | None = Query(default=None),
    mitre: str | None = Query(default=None, max_length=40),
    q: str | None = Query(default=None, max_length=200),
    since: datetime | None = Query(default=None),
    until: datetime | None = Query(default=None),
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> CasePage:
    """Alertes regroupées en dossiers (une règle = un dossier) + état de la file."""
    return await svc.list_cases(session, severity=severity, status=status, mitre=mitre, q=q, since=since, until=until)


@router.post("/cases/triage", response_model=BulkTriageResult)
async def triage_case(
    payload: CaseTriage,
    session: AsyncSession = Depends(get_session),
    user: User = Depends(require_role(Role.admin, Role.analyst)),
) -> BulkTriageResult:
    """Triage d'un dossier entier (toutes les alertes de la règle dont le statut s'y prête)."""
    result = await svc.triage_case(session, payload.rule_id, status=payload.status, resolution=payload.resolution, actor=user.email)
    if result is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Dossier introuvable")
    return result


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
