"""Endpoint overview (agrégats + séries)."""

import psutil
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models.alert import Alert
from app.models.rule import CustomRule
from app.models.user import User
from app.network import inventory as network_inventory
from app.schemas.posture import NavStats, Posture
from app.schemas.stats import OverviewStats
from app.services import events as events_svc
from app.services import posture
from app.services import stats as svc

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("/overview", response_model=OverviewStats)
async def overview(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> OverviewStats:
    return await svc.overview(session)


@router.get("/posture", response_model=Posture)
async def security_posture(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> Posture:
    """Posture du poste en 5 piliers (menaces, exposition, défense, visibilité, santé),
    avec les constats sourcés et les priorités d'action. Lecture seule."""
    return await posture.collect(session)


_COLLECTION = {"ok": "ok", "warn": "degraded", "critical": "down", "unknown": "unknown"}


@router.get("/nav", response_model=NavStats)
async def nav_stats(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> NavStats:
    """Badges de la barre latérale : posture (cache 30 s), alertes ouvertes, activité, règles."""
    p = await posture.cached(session)
    is_open = Alert.status.in_(("new", "ack"))
    open_alerts = await session.scalar(select(func.count()).select_from(Alert).where(is_open)) or 0
    open_critical = await session.scalar(select(func.count()).select_from(Alert).where(is_open, Alert.severity == "critical")) or 0
    rules_enabled = await session.scalar(select(func.count()).select_from(CustomRule).where(CustomRule.enabled.is_(True))) or 0
    try:
        events_5min = await events_svc.count_events(channel=None, event_id=None, keywords=[], minutes=5)
    except Exception:  # noqa: BLE001 - OpenSearch indisponible : le badge se tait, la barre reste utilisable
        events_5min = 0
    visibility = next((x.tone for x in p.pillars if x.key == "visibility"), "unknown")
    network_new, network_spoofed = await network_inventory.nav_counts()
    return NavStats(
        posture_score=p.score,
        posture_tone=p.tone,
        open_alerts=open_alerts,
        open_critical=open_critical,
        events_5min=events_5min,
        rules_enabled=rules_enabled,
        cpu_percent=psutil.cpu_percent(interval=None),
        collection=_COLLECTION[visibility],
        network_new=network_new,
        network_spoofed=network_spoofed,
    )
