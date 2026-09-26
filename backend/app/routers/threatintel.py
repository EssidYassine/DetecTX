"""Endpoints Threat Intelligence."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models.user import User
from app.schemas.intel import IntelResult
from app.threatintel import service as svc

router = APIRouter(prefix="/threatintel", tags=["threatintel"])
settings = get_settings()


@router.get("/status")
async def status_(_: User = Depends(get_current_user)) -> dict:
    return {
        "virustotal": bool(settings.virustotal_api_key),
        "abuseipdb": bool(settings.abuseipdb_api_key),
        "misp": bool(settings.misp_url and settings.misp_key),
    }


@router.get("/lookup", response_model=IntelResult)
async def lookup(
    indicator: str = Query(min_length=1),
    type: str | None = Query(default=None, pattern="^(ip|hash|domain)$"),
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> IntelResult:
    return await svc.lookup(session, indicator, type)
