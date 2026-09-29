"""CRUD des règles de détection personnalisées."""

import re
import unicodedata

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.models.alert import Alert
from app.models.rule import CustomRule
from app.models.user import Role, User
from app.schemas.rules import RuleIn, RuleOut, RulePreview
from app.services import events as events_svc

router = APIRouter(prefix="/rules", tags=["rules"])

NOISY_PER_DAY = 500  # au-delà, la règle noierait la file d'alertes
ENGINE_CAP = 200  # le moteur crée au plus 200 alertes par règle et par exécution (engine._run_match_rule)


def _require_criteria(payload: RuleIn) -> None:
    if not payload.keywords and not (payload.channel or payload.event_id is not None):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Fournir au moins des mots-clés, ou un journal / event_id.",
        )


def _slug(title: str) -> str:
    ascii_title = unicodedata.normalize("NFKD", title).encode("ascii", "ignore").decode()  # « é » -> « e »
    base = re.sub(r"[^a-z0-9]+", "-", ascii_title.lower()).strip("-")[:60] or "regle"
    return f"custom-{base}"


@router.get("", response_model=list[RuleOut])
async def list_rules(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> list[RuleOut]:
    rows = (await session.scalars(select(CustomRule).order_by(CustomRule.created_at.desc()))).all()
    counts = dict((await session.execute(select(Alert.rule_id, func.count()).where(Alert.rule_id.in_([r.rule_id for r in rows])).group_by(Alert.rule_id))).all()) if rows else {}
    return [RuleOut.model_validate(r).model_copy(update={"alerts": counts.get(r.rule_id, 0)}) for r in rows]


@router.post("/preview", response_model=RulePreview)
async def preview_rule(
    payload: RuleIn,
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> RulePreview:
    """Ce que la règle aurait trouvé sur 24 h et 7 jours, avec 5 exemples. Lecture seule."""
    _require_criteria(payload)
    crit = {"channel": payload.channel, "event_id": payload.event_id, "keywords": payload.keywords}
    day = await events_svc.count_events(**crit, minutes=60 * 24)
    week = await events_svc.count_events(**crit, minutes=60 * 24 * 7)
    samples = await events_svc.search_events(**crit, minutes=60 * 24 * 7, limit=5)
    if payload.threshold_count and payload.threshold_minutes:
        window = await events_svc.count_events(**crit, minutes=payload.threshold_minutes)
        would_alert = 1 if window >= payload.threshold_count else 0
    else:
        would_alert = min(ENGINE_CAP, await events_svc.count_events(**crit, minutes=None))
    return RulePreview(matches_24h=day, matches_7d=week, samples=samples.items, noisy=day > NOISY_PER_DAY or week > NOISY_PER_DAY * 7, would_alert=would_alert)


@router.post("", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
async def create_rule(
    payload: RuleIn,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> CustomRule:
    _require_criteria(payload)
    rule_id = _slug(payload.title)
    exists = await session.scalar(select(CustomRule).where(CustomRule.rule_id == rule_id))
    if exists:
        rule_id = f"{rule_id}-{int(exists.id)}"

    rule = CustomRule(
        rule_id=rule_id,
        title=payload.title,
        description=payload.description,
        level=payload.level,
        mitre=payload.mitre,
        channel=payload.channel or None,
        event_id=payload.event_id,
        keywords=payload.keywords,
        threshold_count=payload.threshold_count,
        threshold_minutes=payload.threshold_minutes,
    )
    session.add(rule)
    await session.commit()
    await session.refresh(rule)
    return rule


@router.patch("/{rule_id}/toggle", response_model=RuleOut)
async def toggle_rule(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> CustomRule:
    rule = await session.get(CustomRule, rule_id)
    if not rule:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Règle introuvable")
    rule.enabled = not rule.enabled
    await session.commit()
    await session.refresh(rule)
    return rule


@router.delete("/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(
    rule_id: int,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> None:
    rule = await session.get(CustomRule, rule_id)
    if rule:
        await session.delete(rule)
        await session.commit()
