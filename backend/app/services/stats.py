"""Agrégats pour l'overview : totaux + séries temporelles horaires (24h)."""

from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.mitre import technique_meta
from app.models.alert import Alert
from app.schemas.stats import MitreDetail, OverviewStats
from app.services import alerts as alerts_svc
from app.services import events as events_svc


def _to_dt(value) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None


def _hourly_series(timestamps: list[datetime], hours: int = 24) -> list[int]:
    now = datetime.now(timezone.utc)
    start = now - timedelta(hours=hours)
    buckets = [0] * hours
    for ts in timestamps:
        if ts is None or ts < start:
            continue
        idx = int((ts - start).total_seconds() // 3600)
        if 0 <= idx < hours:
            buckets[idx] += 1
    return buckets


async def overview(session: AsyncSession) -> OverviewStats:
    # Agrégats existants
    try:
        estats = await events_svc.events_stats()
    except Exception:  # noqa: BLE001 — OpenSearch éventuellement absent
        estats = None
    astats = await alerts_svc.alerts_stats(session)

    # Série événements (24h) — depuis les événements récents
    ev_ts: list[datetime] = []
    try:
        rows = await events_svc.query_events(
            channel=None, event_id=None, keywords=[], minutes=1440, limit=20000
        )
        ev_ts = [t for t in (_to_dt(r.get("timestamp")) for r in rows) if t]
    except Exception:  # noqa: BLE001
        ev_ts = []

    # Série alertes (24h) — depuis la base
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    al_rows = await session.scalars(select(Alert.created_at).where(Alert.created_at >= since))
    al_ts = [t for t in (_to_dt(v) for v in al_rows.all()) if t]

    return OverviewStats(
        events_total=(estats.total if estats else 0),
        events_24h=(estats.last_24h if estats else len(ev_ts)),
        alerts_total=astats.total,
        by_severity=astats.by_severity,
        by_mitre=astats.by_mitre,
        by_channel=(estats.by_channel if estats else {}),
        events_series=_hourly_series(ev_ts),
        alerts_series=_hourly_series(al_ts),
        mitre_details=[
            MitreDetail(**technique_meta(tid), count=count)
            for tid, count in sorted(astats.by_mitre.items(), key=lambda kv: kv[1], reverse=True)
        ],
    )
