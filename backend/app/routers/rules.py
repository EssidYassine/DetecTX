"""CRUD des règles de détection personnalisées."""

import re

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.models.rule import CustomRule
from app.models.user import Role, User
from app.schemas.rules import RuleIn, RuleOut

router = APIRouter(prefix="/rules", tags=["rules"])


def _slug(title: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:60] or "regle"
    return f"custom-{base}"


@router.get("", response_model=list[RuleOut])
async def list_rules(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> list[CustomRule]:
    rows = await session.scalars(select(CustomRule).order_by(CustomRule.created_at.desc()))
    return list(rows.all())


@router.post("", response_model=RuleOut, status_code=status.HTTP_201_CREATED)
async def create_rule(
    payload: RuleIn,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> CustomRule:
    if not payload.keywords and not (payload.channel or payload.event_id):
        raise HTTPException(
            status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Fournir au moins des mots-clés, ou un canal / event_id.",
        )
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
