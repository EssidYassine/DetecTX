"""Couverture MITRE ATT&CK réelle (lecture seule)."""

from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Path, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models.user import User
from app.schemas.mitre import Coverage, TechniqueDetail
from app.services import attack

router = APIRouter(prefix="/mitre", tags=["mitre"])

TechniqueId = Annotated[str, Path(pattern=r"^T\d{4}(\.\d{3})?$")]


@router.get("/coverage", response_model=Coverage)
async def coverage(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> dict:
    """Pour chaque technique : règles théoriques / réellement actives, alertes observées,
    et le plan de couverture (sources à activer, gain attendu)."""
    rules, available, alerts = await attack.gather(session)
    return attack.coverage(rules, available, alerts)


@router.get("/techniques/{tid}", response_model=TechniqueDetail)
async def technique(
    tid: TechniqueId,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> dict:
    rules, available, alerts = await attack.gather(session)
    found = next((t for t in attack.coverage(rules, available, alerts)["techniques"] if t["id"] == tid), None)
    if found is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Technique inconnue")
    return {**found, "rules": attack.rules_for(rules, tid, available)}
