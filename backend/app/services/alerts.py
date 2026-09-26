"""Persistance et lecture des alertes (PostgreSQL)."""

import asyncio

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import notify
from app.detection import engine, sigma
from app.detection.engine import Rule, RuleMatch, RuleThreshold
from app.models.alert import Alert
from app.models.rule import CustomRule
from app.schemas.alerts import AlertPage, AlertStats, DetectionRunResult
from app.services import events as events_svc


async def save_alerts(session: AsyncSession, candidates: list[dict]) -> list[dict]:
    """Insère les candidats non déjà connus (dédup sur dedup_key). Retourne les créés."""
    if not candidates:
        return []

    keys = {c["dedup_key"] for c in candidates}
    existing = set(
        (await session.scalars(select(Alert.dedup_key).where(Alert.dedup_key.in_(keys)))).all()
    )

    created: list[dict] = []
    seen: set[str] = set()
    for c in candidates:
        key = c["dedup_key"]
        if key in existing or key in seen:
            continue
        seen.add(key)
        session.add(Alert(**c))
        created.append(c)

    if created:
        await session.commit()
    return created


def _to_engine_rule(c: CustomRule) -> Rule:
    threshold = (
        RuleThreshold(count=c.threshold_count, minutes=c.threshold_minutes)
        if c.threshold_count and c.threshold_minutes
        else None
    )
    return Rule(
        id=c.rule_id,
        title=c.title,
        description=c.description,
        level=c.level,
        mitre=c.mitre,
        match=RuleMatch(channel=c.channel, event_id=c.event_id, keywords=c.keywords or []),
        threshold=threshold,
    )


async def run_detection(session: AsyncSession) -> DetectionRunResult:
    """Exécute règles internes + custom (UI) + référentiel Sigma, enregistre et notifie."""
    custom = (await session.scalars(select(CustomRule).where(CustomRule.enabled.is_(True)))).all()
    candidates = await engine.detect([_to_engine_rule(c) for c in custom])

    # Règles SigmaHQ : évaluées en thread (CPU-bound) sur les événements récents.
    events = await events_svc.query_events(
        channel=None, event_id=None, keywords=[], minutes=None, limit=10000
    )
    candidates += await asyncio.to_thread(sigma.detect_over_events, events)

    created = await save_alerts(session, candidates)

    # Notification Discord des nouvelles alertes importantes (si configuré).
    if created and notify.enabled():
        try:
            await notify.notify_alerts(created)
        except Exception:  # noqa: BLE001
            pass

    rules_run = len(engine.load_rules()) + len(custom) + len(sigma.load_sigma_rules())
    return DetectionRunResult(rules_run=rules_run, alerts_created=len(created))


async def list_alerts(
    session: AsyncSession,
    *,
    severity: str | None = None,
    status: str | None = None,
    mitre: str | None = None,
    q: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> AlertPage:
    conditions = []
    if severity:
        conditions.append(Alert.severity == severity)
    if status:
        conditions.append(Alert.status == status)
    if mitre:
        conditions.append(Alert.mitre == mitre)
    if q:
        like = f"%{q}%"
        conditions.append(or_(Alert.rule_title.ilike(like), Alert.message.ilike(like)))

    total = await session.scalar(
        select(func.count()).select_from(Alert).where(*conditions)
    )
    rows = (
        await session.scalars(
            select(Alert)
            .where(*conditions)
            .order_by(Alert.risk_score.desc(), Alert.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()
    return AlertPage(total=total or 0, items=list(rows))


async def alerts_stats(session: AsyncSession) -> AlertStats:
    total = await session.scalar(select(func.count()).select_from(Alert)) or 0

    sev_rows = await session.execute(
        select(Alert.severity, func.count()).group_by(Alert.severity)
    )
    mitre_rows = await session.execute(
        select(Alert.mitre, func.count()).where(Alert.mitre.is_not(None)).group_by(Alert.mitre)
    )
    return AlertStats(
        total=total,
        by_severity={sev: n for sev, n in sev_rows.all()},
        by_mitre={m: n for m, n in mitre_rows.all()},
    )
