"""Endpoint overview (agrégats + séries)."""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models.user import User
from app.schemas.stats import OverviewStats
from app.services import stats as svc

router = APIRouter(prefix="/stats", tags=["stats"])


@router.get("/overview", response_model=OverviewStats)
async def overview(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> OverviewStats:
    return await svc.overview(session)
