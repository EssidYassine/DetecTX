"""Endpoints des événements : ingestion (collecteurs) et lecture (dashboard)."""

from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.schemas.events import (
    EventDetail,
    EventHistogram,
    EventPage,
    EventStats,
    FeedItem,
    HuntOut,
    IngestBatch,
    IngestResult,
)
from app.services import collection, event_insights
from app.services import events as svc

router = APIRouter(prefix="/events", tags=["events"])

# Clé d'événement : entier SQL ou _id OpenSearch (alphanumérique, - et _).
EventKey = Annotated[str, Path(pattern=r"^[A-Za-z0-9_-]{1,64}$")]


@router.post("/ingest", response_model=IngestResult)
async def ingest(
    batch: IngestBatch,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> IngestResult:
    """Reçoit un lot d'événements d'un collecteur (PowerShell / Fluent Bit).
    Un lot vide avec `agent` renseigné est un battement de cœur."""
    computer = batch.agent.computer if batch.agent else next((e.computer for e in batch.events if e.computer), None)
    if batch.agent or batch.events:
        collection.record(
            computer or "inconnu",
            kind="agent",
            version=batch.agent.version if batch.agent else None,
            admin=batch.agent.admin if batch.agent else None,
            interval_sec=batch.agent.interval_sec if batch.agent else None,
        )
    indexed = await svc.index_events(batch.events) if batch.events else 0
    return IngestResult(indexed=indexed)


@router.get("", response_model=EventPage)
async def list_events(
    channel: str | None = Query(default=None, max_length=255),
    event_id: int | None = Query(default=None, ge=0),
    q: str | None = Query(default=None, max_length=200, description="Recherche plein texte dans le message"),
    hunt: str | None = Query(default=None, max_length=40, description="Identifiant d'une chasse prête à l'emploi"),
    theme: str | None = Query(default=None, max_length=20, description="Thème du relief (journaux regroupés)"),
    minutes: int | None = Query(default=None, ge=1, le=60 * 24 * 90, description="Fenêtre : N dernières minutes"),
    since: datetime | None = Query(default=None, description="Début de tranche (inclus)"),
    until: datetime | None = Query(default=None, description="Fin de tranche (exclue)"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_current_user),
) -> EventPage:
    """Liste paginée des événements de l'hôte, du plus récent au plus ancien.
    Une chasse fixe journaux, identifiants et mots-clés ; `q` affine en plus."""
    if hunt:
        filters = event_insights.hunt_filters(hunt)
        if filters is None:
            raise HTTPException(status_code=404, detail="Chasse inconnue.")
        return await svc.search_events(**filters, q=q, minutes=minutes, since=since, until=until, offset=offset, limit=limit)
    channels: str | list[str] | None = channel
    if theme:
        channels = event_insights.theme_channels(theme)
        if channels is None:
            raise HTTPException(status_code=404, detail="Thème inconnu.")
    return await svc.search_events(channel=channels, event_id=event_id, q=q, minutes=minutes, since=since, until=until, offset=offset, limit=limit)


@router.get("/stats", response_model=EventStats)
async def stats(_: User = Depends(get_current_user)) -> EventStats:
    """Compteurs pour les cartes KPI (total, dernières 24h, par canal)."""
    return await svc.events_stats()


@router.get("/health")
async def health(_: User = Depends(get_current_user)) -> dict:
    """Santé de la collecte : agent, Sysmon, dernier événement par journal."""
    return await event_insights.health()


@router.get("/histogram", response_model=EventHistogram)
async def histogram(
    hours: int = Query(default=48, ge=6, le=168),
    _: User = Depends(get_current_user),
) -> EventHistogram:
    """Événements par heure et par journal (relief de l'activité) + alertes par tranche."""
    return await event_insights.histogram(hours)


@router.get("/hunts", response_model=list[HuntOut])
async def hunts(
    minutes: int = Query(default=60 * 24 * 7, ge=60, le=60 * 24 * 90),
    _: User = Depends(get_current_user),
) -> list[HuntOut]:
    """Chasses prêtes à l'emploi, avec le nombre d'événements correspondants sur la période."""
    return await event_insights.hunt_counts(minutes)


@router.get("/feed", response_model=list[FeedItem])
async def feed(
    minutes: int = Query(default=60 * 24, ge=5, le=60 * 24 * 7),
    limit: int = Query(default=40, ge=1, le=100),
    _: User = Depends(get_current_user),
) -> list[FeedItem]:
    """Fil de la machine : événements marquants récents, racontés en une phrase."""
    return await event_insights.feed(minutes, limit)


@router.get("/{event_key}", response_model=EventDetail)
async def event_detail(event_key: EventKey, _: User = Depends(get_current_user)) -> EventDetail:
    """Un événement complet : champs, explication de l'Event ID, alertes liées."""
    detail = await event_insights.get_event(event_key)
    if detail is None:
        raise HTTPException(status_code=404, detail="Événement introuvable.")
    return detail
