"""Persistance et lecture des alertes (PostgreSQL)."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import case, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app import notify
from app.ai.mitre import technique_meta
from app.detection import engine, sigma
from app.detection.engine import Rule, RuleMatch, RuleThreshold
from app.models.alert import Alert
from app.models.rule import CustomRule
from app.schemas.alerts import (
    AlertCase,
    AlertPage,
    AlertStats,
    AlertTimeline,
    BulkTriageResult,
    CasePage,
    CaseSummary,
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


OPEN_STATUSES = ("new", "ack")
SEVERITY_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}
_RANK_SEVERITY = {v: k for k, v in SEVERITY_RANK.items()}


def _when():
    """Date de référence d'une alerte : celle de l'événement (repli : date de détection)."""
    return func.coalesce(Alert.event_timestamp, Alert.created_at)


def _like(text: str) -> str:
    """Motif LIKE littéral : %, _ et \\ saisis par l'utilisateur ne sont pas des jokers."""
    escaped = text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    return f"%{escaped}%"


def _conditions(
    *,
    severity: str | None = None,
    status: str | None = None,
    mitre: str | None = None,
    q: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    rule_id: str | None = None,
) -> list:
    conditions = []
    when = _when()
    if since:
        conditions.append(when >= since)
    if until:
        conditions.append(when < until)
    if severity:
        conditions.append(Alert.severity == severity)
    if status == "open":
        conditions.append(Alert.status.in_(OPEN_STATUSES))
    elif status:
        conditions.append(Alert.status == status)
    if mitre:
        conditions.append(Alert.mitre == mitre)
    if rule_id:
        conditions.append(Alert.rule_id == rule_id)
    if q:
        like = _like(q)
        conditions.append(or_(Alert.rule_title.ilike(like, escape="\\"), Alert.message.ilike(like, escape="\\")))
    return conditions


async def list_alerts(
    session: AsyncSession,
    *,
    severity: str | None = None,
    status: str | None = None,
    mitre: str | None = None,
    q: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    rule_id: str | None = None,
    offset: int = 0,
    limit: int = 50,
) -> AlertPage:
    conditions = _conditions(severity=severity, status=status, mitre=mitre, q=q, since=since, until=until, rule_id=rule_id)
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


MAX_CASES = 300


async def list_cases(
    session: AsyncSession,
    *,
    severity: str | None = None,
    status: str | None = None,
    mitre: str | None = None,
    q: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
) -> CasePage:
    """Alertes regroupées par règle (les filtres portent sur les alertes, puis on regroupe).
    Tri : dossiers ouverts d'abord, puis gravité, risque, dernière occurrence."""
    conditions = _conditions(severity=severity, status=status, mitre=mitre, q=q, since=since, until=until)
    when = _when()
    rank = case(*((Alert.severity == sev, r) for sev, r in SEVERITY_RANK.items()), else_=0)
    per_status = [func.sum(case((Alert.status == st, 1), else_=0)) for st in ("new", "ack", "closed")]
    rows = (
        await session.execute(
            select(
                Alert.rule_id,
                func.max(Alert.rule_title),
                func.max(rank),
                func.max(Alert.risk_score),
                func.max(Alert.mitre),
                func.count(),
                func.min(when),
                func.max(when),
                func.max(Alert.id),
                *per_status,
            )
            .where(*conditions)
            .group_by(Alert.rule_id)
        )
    ).all()

    latest_ids = [r[8] for r in rows]
    messages: dict[int, str | None] = {}
    channels: dict[str, set[str]] = {}
    if rows:
        messages = dict((await session.execute(select(Alert.id, Alert.message).where(Alert.id.in_(latest_ids)))).all())
        for rule_id, channel in (await session.execute(select(Alert.rule_id, Alert.channel).where(*conditions).distinct())).all():
            if channel:
                channels.setdefault(rule_id, set()).add(channel)

    cases = []
    for rule_id, title, sev_rank, risk, mitre_id, count, first, last, latest, n_new, n_ack, n_closed in rows:
        meta = technique_meta(mitre_id) if mitre_id else {"name": None, "tactic": None, "tactic_fr": None}
        cases.append(
            AlertCase(
                rule_id=rule_id,
                rule_title=title,
                severity=_RANK_SEVERITY.get(sev_rank or 0, "low"),
                risk=risk or 0,
                mitre=mitre_id,
                mitre_name=meta["name"],
                tactic=meta["tactic"],
                tactic_fr=meta["tactic_fr"],
                count=count,
                by_status={"new": n_new or 0, "ack": n_ack or 0, "closed": n_closed or 0},
                first_seen=first,
                last_seen=last,
                latest_id=latest,
                latest_message=messages.get(latest),
                channels=sorted(channels.get(rule_id, ())),
            )
        )
    cases.sort(
        key=lambda c: (c.by_status["new"] + c.by_status["ack"] > 0, SEVERITY_RANK.get(c.severity, 0), c.risk, c.last_seen),
        reverse=True,
    )
    return CasePage(total=len(cases), cases=cases[:MAX_CASES], summary=await case_summary(session))


async def case_summary(session: AsyncSession) -> CaseSummary:
    """État de la file (indépendant des filtres) : ce qui reste à traiter et comment on trie."""
    is_open = Alert.status.in_(OPEN_STATUSES)
    open_alerts = await session.scalar(select(func.count()).select_from(Alert).where(is_open)) or 0
    open_critical = await session.scalar(select(func.count()).select_from(Alert).where(is_open, Alert.severity == "critical")) or 0
    open_cases = await session.scalar(select(func.count(func.distinct(Alert.rule_id))).where(is_open)) or 0
    open_mitre = (await session.scalars(select(Alert.mitre).where(is_open, Alert.mitre.is_not(None)).distinct())).all()
    tactics = sorted({t for t in (technique_meta(m)["tactic"] for m in open_mitre) if t})
    resolutions = dict(
        (await session.execute(select(Alert.resolution, func.count()).where(Alert.status == "closed").group_by(Alert.resolution))).all()
    )
    triaged = (
        # Alertes effectivement traitées (une alerte rouverte n'est plus « triée »).
        await session.execute(
            select(Alert.created_at, Alert.triaged_at).where(Alert.triaged_at.is_not(None), Alert.status.in_(("ack", "closed"))).limit(5000)
        )
    ).all()
    delays = [(t - c).total_seconds() / 60 for c, t in triaged if c and t and t >= c]
    return CaseSummary(
        open_alerts=open_alerts,
        open_cases=open_cases,
        open_critical=open_critical,
        tactics_hit=tactics,
        closed=sum(resolutions.values()),
        true_positive=resolutions.get("true_positive", 0),
        false_positive=resolutions.get("false_positive", 0),
        mean_triage_minutes=round(sum(delays) / len(delays), 1) if delays else None,
    )


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


# Statuts de départ d'un triage de dossier : on ne « prend en charge » que des nouvelles, etc.
_CASE_SOURCES = {"ack": ("new",), "closed": ("new", "ack"), "new": ("ack", "closed")}
MAX_CASE_TRIAGE = 5000


async def triage_case(
    session: AsyncSession, rule_id: str, *, status: str, resolution: str | None, actor: str
) -> BulkTriageResult | None:
    """Triage de toutes les alertes d'une règle dont le statut s'y prête. None si la règle
    n'a aucune alerte (le routeur répond 404)."""
    exists = await session.scalar(select(Alert.id).where(Alert.rule_id == rule_id).limit(1))
    if exists is None:
        return None
    ids = (
        await session.scalars(
            select(Alert.id).where(Alert.rule_id == rule_id, Alert.status.in_(_CASE_SOURCES[status])).limit(MAX_CASE_TRIAGE)
        )
    ).all()
    if not ids:
        return BulkTriageResult(updated=0, missing=[])
    return await triage_alerts(session, list(ids), status=status, resolution=resolution, actor=actor)


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
