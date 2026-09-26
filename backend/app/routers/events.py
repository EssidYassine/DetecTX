"""Endpoints des événements : ingestion (collecteurs) et lecture (dashboard)."""

from fastapi import APIRouter, Depends, Query

from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.schemas.events import EventPage, EventStats, IngestBatch, IngestResult
from app.services import events as svc

router = APIRouter(prefix="/events", tags=["events"])


@router.post("/ingest", response_model=IngestResult)
async def ingest(
    batch: IngestBatch,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> IngestResult:
    """Reçoit un lot d'événements d'un collecteur (PowerShell / Fluent Bit)."""
    indexed = await svc.index_events(batch.events)
    return IngestResult(indexed=indexed)


@router.get("", response_model=EventPage)
async def list_events(
    channel: str | None = Query(default=None),
    event_id: int | None = Query(default=None),
    q: str | None = Query(default=None, description="Recherche plein texte dans le message"),
    minutes: int | None = Query(default=None, ge=1, description="Fenêtre : N dernières minutes"),
    offset: int = Query(default=0, ge=0),
    limit: int = Query(default=50, ge=1, le=200),
    _: User = Depends(get_current_user),
) -> EventPage:
    """Liste paginée des événements de l'hôte, du plus récent au plus ancien."""
    return await svc.search_events(
        channel=channel,
        event_id=event_id,
        q=q,
        minutes=minutes,
        offset=offset,
        limit=limit,
    )


@router.get("/stats", response_model=EventStats)
async def stats(_: User = Depends(get_current_user)) -> EventStats:
    """Compteurs pour les cartes KPI (total, dernières 24h, par canal)."""
    return await svc.events_stats()
