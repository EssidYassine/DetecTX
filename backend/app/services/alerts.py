"""Persistance et lecture des alertes (PostgreSQL)."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import notify
from app.detection import engine, sigma
from app.detection.engine import Rule, RuleMatch, RuleThreshold
from app.models.alert import Alert
from app.models.rule import CustomRule
from app.schemas.alerts import (
    AlertPage,
    AlertStats,
    AlertTimeline,
    BulkTriageResult,
    DetectionRunResult,
    TimelineDay,
)
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
    since: datetime | None = None,
    until: datetime | None = None,
    offset: int = 0,
    limit: int = 50,
) -> AlertPage:
    conditions = []
    # Période sur la date de l'événement (repli : date de détection).
    when = func.coalesce(Alert.event_timestamp, Alert.created_at)
    if since:
        conditions.append(when >= since)
    if until:
        conditions.append(when < until)
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
    status_rows = await session.execute(select(Alert.status, func.count()).group_by(Alert.status))
    return AlertStats(
        total=total,
        by_severity={sev: n for sev, n in sev_rows.all()},
        by_mitre={m: n for m, n in mitre_rows.all()},
        by_status={st: n for st, n in status_rows.all()},
    )


audit_log = logging.getLogger("detectx.audit")


async def triage_alerts(
    session: AsyncSession,
    ids: list[int],
    *,
    status: str,
    resolution: str | None,
    actor: str,
) -> BulkTriageResult:
    """Change le statut d'une ou plusieurs alertes et trace qui l'a fait et quand."""
    wanted = list(dict.fromkeys(ids))  # dédoublonne en gardant l'ordre
    rows = (await session.scalars(select(Alert).where(Alert.id.in_(wanted)))).all()
    now = datetime.now(timezone.utc)
    for alert in rows:
        alert.status = status
        alert.resolution = resolution
        alert.triaged_by = actor
        alert.triaged_at = now
    await session.commit()
    found = {a.id for a in rows}
    audit_log.info(
        "triage actor=%s status=%s resolution=%s ids=%s",
        actor, status, resolution, sorted(found),
    )
    return BulkTriageResult(updated=len(rows), missing=[i for i in wanted if i not in found])


async def alerts_timeline(session: AsyncSession, *, days: int, tz_offset_min: int) -> AlertTimeline:
    """Alertes par jour et par sévérité sur `days` jours (aujourd'hui inclus).

    Les jours sont ceux du navigateur : `tz_offset_min` = décalage de l'heure locale sur UTC
    en minutes (UTC+2 -> 120). La date retenue est celle de l'événement (repli : détection).
    """
    offset = timedelta(minutes=tz_offset_min)
    today = (datetime.now(timezone.utc) + offset).date()
    first = today - timedelta(days=days - 1)
    since_utc = datetime(first.year, first.month, first.day, tzinfo=timezone.utc) - offset

    when = func.coalesce(Alert.event_timestamp, Alert.created_at)
    rows = (await session.execute(select(Alert.severity, when).where(when >= since_utc))).all()

    buckets = {first + timedelta(days=i): TimelineDay(date=first + timedelta(days=i)) for i in range(days)}
    for severity, ts in rows:
        if ts is None:
            continue
        if ts.tzinfo is None:  # SQLite renvoie des dates naïves (stockées en UTC)
            ts = ts.replace(tzinfo=timezone.utc)
        day = (ts + offset).date()
        bucket = buckets.get(day)
        if bucket is not None and severity in ("critical", "high", "medium", "low"):
            setattr(bucket, severity, getattr(bucket, severity) + 1)
    return AlertTimeline(days=list(buckets.values()))
