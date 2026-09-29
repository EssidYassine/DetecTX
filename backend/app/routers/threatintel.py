"""Threat Intelligence : indicateurs DU POSTE uniquement, listes publiques, vulnérabilités.

Les listes publiques ne sont jamais exposées : elles servent de référence locale. L'analyse en
ligne (VirusTotal, AbuseIPDB, MISP, OTX) n'accepte que des indicateurs présents dans
l'inventaire du poste — pas de recherche d'IOC arbitraires.
"""

import asyncio
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.models.user import Role, User
from app.schemas.intel import IndicatorDetail, IntelOverview, IntelResult, VulnReport
from app.threatintel import feeds, inventory, overview, service, vulns

router = APIRouter(prefix="/threatintel", tags=["threatintel"])
_background: set[asyncio.Task] = set()  # référence forte : une tâche non référencée peut être collectée

FeedId = Annotated[str, Path(pattern=r"^[a-z]{2,20}$")]
Value = Annotated[str, Query(min_length=2, max_length=253)]


async def _machine_indicator(session: AsyncSession, value: str) -> inventory.Indicator:
    wanted = value.strip().lower()
    found = next((i for i in await inventory.collect(session) if i.value.lower() == wanted), None)
    if found is None:  # connexion toute récente : inventaire recalculé une fois avant de refuser
        found = next((i for i in await inventory.collect(session, force=True) if i.value.lower() == wanted), None)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Indicateur absent de l'inventaire de ce poste.")
    return found


@router.get("/status")
async def status_(_: User = Depends(get_current_user)) -> dict:
    return {"providers": [p.model_dump() for p in overview.providers()], "feeds": [f.model_dump(mode="json") for f in overview.feed_statuses()]}


@router.get("/overview", response_model=IntelOverview)
async def intel_overview(session: AsyncSession = Depends(get_session), _: User = Depends(get_current_user)) -> dict:
    """Inventaire des indicateurs du poste comparé localement aux listes publiques."""
    return await overview.build(session, await inventory.collect(session))


@router.get("/indicator", response_model=IndicatorDetail)
async def indicator(value: Value, session: AsyncSession = Depends(get_session), _: User = Depends(get_current_user)) -> dict:
    return await overview.detail(session, await _machine_indicator(session, value))


@router.post("/indicator/lookup", response_model=IntelResult)
async def indicator_lookup(value: Value, session: AsyncSession = Depends(get_session), user: User = Depends(require_role(Role.admin, Role.analyst))) -> IntelResult:
    """Analyse en ligne d'un indicateur DU POSTE (jamais d'IP non publique), limitée en débit."""
    item = await _machine_indicator(session, value)
    try:
        service.validate(item.value)
        service.check_rate(user.email)
    except service.LookupRefused as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, str(exc)) from exc
    except service.RateLimited as exc:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Trop d'analyses en ligne : {service.RATE_LIMIT} par minute au plus.") from exc
    return await service.lookup(session, item.value)


@router.post("/feeds/refresh")
async def refresh_feeds(user: User = Depends(require_role(Role.admin))) -> dict:
    feeds.audit.info("threatintel.refresh actor=%s", user.email)
    await feeds.refresh()
    return {"feeds": [f.model_dump(mode="json") for f in overview.feed_statuses()]}


@router.patch("/feeds/{feed_id}")
async def toggle_feed(feed_id: FeedId, enabled: bool = Query(), user: User = Depends(require_role(Role.admin))) -> dict:
    if feed_id not in feeds.BY_ID:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Liste inconnue")
    feeds.set_enabled(feed_id, enabled, user.email)
    return {"feeds": [f.model_dump(mode="json") for f in overview.feed_statuses()]}


@router.get("/vulns", response_model=VulnReport)
async def vulnerabilities(_: User = Depends(get_current_user)) -> dict:
    """Dernier rapport (Windows Update, logiciels × KEV × NVD). L'analyse tourne en tâche de fond."""
    report = vulns.last_report() or {}
    return {
        "scanned_at": report.get("scanned_at"),
        "running": vulns.is_running(),
        "os": report.get("os", {}),
        "windows_update": report.get("windows_update", {"available": False, "error": None, "updates": []}),
        "software_count": report.get("software_count", 0),
        "kev_entries": report.get("kev_entries", 0),
        "findings": report.get("findings", []),
    }


@router.post("/vulns/refresh", status_code=status.HTTP_202_ACCEPTED)
async def refresh_vulns(user: User = Depends(require_role(Role.admin))) -> dict:
    if vulns.is_running():
        return {"started": False, "detail": "Analyse déjà en cours."}
    feeds.audit.info("threatintel.vulns_scan actor=%s", user.email)
    task = asyncio.create_task(vulns.scan())  # ~1 min (Windows Update) : on répond tout de suite
    _background.add(task)
    task.add_done_callback(_background.discard)
    return {"started": True, "detail": "Analyse lancée (environ une minute)."}
