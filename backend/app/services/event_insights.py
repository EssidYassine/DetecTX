"""Analyses de la page Événements : lecteur d'événement, relief horaire, santé par journal,
compteurs des chasses. Fonctionne avec les deux stockages (SQL local et OpenSearch).

Les requêtes OpenSearch sont construites par des fonctions pures (testées sans cluster).
"""

from datetime import datetime, timedelta, timezone

from opensearchpy.exceptions import NotFoundError
from sqlalchemy import case, func, select

from app.clients import get_opensearch
from app.db import SessionLocal, engine
from app.detection import event_catalog, event_narrator, hunts
from app.models.alert import Alert
from app.models.event import Event
from app.schemas.events import (
    EventDetail,
    EventHistogram,
    FeedItem,
    HistogramAlert,
    HuntOut,
    LinkedAlert,
    ReliefLane,
)
from app.services import collection, winlog_collector
from app.services import events as ev

HOUR = timedelta(hours=1)


def _aware(dt: datetime | None) -> datetime | None:
    """SQLite rend des dates naïves (stockées en UTC)."""
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _floor_hour(dt: datetime) -> datetime:
    return dt.replace(minute=0, second=0, microsecond=0)


# ─────────────────────────────── lecteur d'événement
async def _linked_alerts(channel: str | None, record_id: int | None, event_id: int | None, ts: datetime) -> list[LinkedAlert]:
    """Alertes levées par le moteur sur CET événement (même journal + même RecordId)."""
    async with SessionLocal() as session:
        if record_id is not None:
            cond = (Alert.channel == channel) & (Alert.event_record_id == record_id)
        else:  # événements sans RecordId (agent) : même journal, même ID, même instant
            cond = (Alert.channel == channel) & (Alert.event_id == event_id) & (Alert.event_timestamp == ts)
        rows = (await session.scalars(select(Alert).where(cond).order_by(Alert.created_at.desc()).limit(20))).all()
    return [LinkedAlert(id=a.id, rule_title=a.rule_title, severity=a.severity, status=a.status, created_at=a.created_at) for a in rows]


async def get_event(event_key: str) -> EventDetail | None:
    if ev._use_sql():
        if not event_key.isdigit():
            return None
        async with SessionLocal() as session:
            row = await session.get(Event, int(event_key))
        if row is None:
            return None
        base, fields = ev._row_to_out(row), row.fields or {}
    else:
        try:
            hit = await get_opensearch().get(index=ev.INDEX, id=event_key)
        except NotFoundError:
            return None
        base, fields = ev._src_to_out(hit), hit["_source"].get("raw") or {}
    return EventDetail(
        **base.model_dump(),
        fields=fields,
        knowledge=event_catalog.describe(base.channel, base.event_id),
        alerts=await _linked_alerts(base.channel, base.record_id, base.event_id, base.timestamp),
    )


# ─────────────────────────────── relief horaire
def os_histogram_body(start: datetime, end: datetime) -> dict:
    return {
        "size": 0,
        "query": {"range": {"@timestamp": {"gte": start.isoformat(), "lt": end.isoformat()}}},
        "aggs": {
            "hours": {
                "date_histogram": {
                    "field": "@timestamp",
                    "fixed_interval": "1h",
                    "min_doc_count": 0,
                    "extended_bounds": {"min": start.isoformat(), "max": (end - HOUR).isoformat()},
                },
                "aggs": {"channels": {"terms": {"field": "channel", "size": 30}}},
            }
        },
    }


def _hour_bucket():
    """Expression SQL « heure pleine » selon le moteur (SQLite en local, PostgreSQL en prod)."""
    if engine.dialect.name == "sqlite":
        return func.strftime("%Y-%m-%d %H:00:00", Event.ts)
    return func.date_trunc("hour", Event.ts)


def _parse_bucket(value) -> datetime:
    if isinstance(value, datetime):
        return _aware(value)
    return datetime.strptime(str(value), "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)


async def histogram(hours: int, now: datetime | None = None) -> EventHistogram:
    now = now or datetime.now(timezone.utc)
    end = _floor_hour(now) + HOUR  # la tranche en cours est incluse
    start = end - hours * HOUR
    counts: dict[str, list[int]] = {}

    def add(channel: str, at: datetime, n: int) -> None:
        index = int((at - start) / HOUR)
        if 0 <= index < hours:
            counts.setdefault(event_catalog.theme_of(channel), [0] * hours)[index] += n

    if ev._use_sql():
        bucket = _hour_bucket()
        async with SessionLocal() as session:
            rows = await session.execute(
                select(Event.channel, bucket, func.count()).where(Event.ts >= start, Event.ts < end).group_by(Event.channel, bucket)
            )
            for channel, value, n in rows.all():
                add(channel, _parse_bucket(value), n)
    else:
        res = await get_opensearch().search(index=ev.INDEX, body=os_histogram_body(start, end))
        for b in res["aggregations"]["hours"]["buckets"]:
            at = datetime.fromtimestamp(b["key"] / 1000, tz=timezone.utc)
            for c in b["channels"]["buckets"]:
                add(c["key"], at, c["doc_count"])

    # Balises d'alertes : sévérité par (tranche, thème).
    alert_bins: dict[tuple[int, str, str], int] = {}
    async with SessionLocal() as session:
        when = func.coalesce(Alert.event_timestamp, Alert.created_at)
        rows = await session.execute(select(when, Alert.channel, Alert.severity).where(when >= start, when < end))
        for at, channel, severity in rows.all():
            index = int((_aware(at) - start) / HOUR)
            if 0 <= index < hours:
                key = (index, event_catalog.theme_of(channel), severity)
                alert_bins[key] = alert_bins.get(key, 0) + 1

    return EventHistogram(
        start=start,
        hours=hours,
        lanes=[ReliefLane(key=t.key, label=t.label) for t in event_catalog.THEMES],
        counts=counts,
        alerts=[HistogramAlert(bin=b, lane=lane, severity=s, count=n) for (b, lane, s), n in sorted(alert_bins.items(), key=lambda kv: kv[0][0])],
    )


def theme_channels(theme: str) -> list[str] | None:
    """Journaux d'un thème (connus du collecteur ou attendus de l'agent). None = thème inconnu."""
    if theme not in {t.key for t in event_catalog.THEMES}:
        return None
    known = [c for c, _ in collection.EXPECTED] + ["DeTecTX-LogFile"]
    return [c for c in known if event_catalog.theme_of(c) == theme]


# ─────────────────────────────── fil de la machine
FOLD_WINDOW = timedelta(minutes=2)


def fold_feed(items: list[FeedItem], window: timedelta = FOLD_WINDOW) -> list[FeedItem]:
    """Replie les répétitions : Windows journalise souvent une même modification plusieurs fois
    dans la seconde (une ligne par variante de règle, par profil…). Même journal + même ID + même
    phrase, à moins de `window` du plus ancien du groupe -> une seule ligne avec un compteur.
    `items` est trié du plus récent au plus ancien ; l'ordre est conservé."""
    out: list[FeedItem] = []
    groups: dict[tuple, tuple[int, datetime]] = {}  # clé -> (index dans out, plus ancien horodatage)
    for item in items:
        key = (item.channel, item.event_id, item.summary or item.title)
        found = groups.get(key)
        if found and found[1] - item.timestamp <= window:
            index, _ = found
            out[index].count += 1
            groups[key] = (index, item.timestamp)
            continue
        groups[key] = (len(out), item.timestamp)
        out.append(item)
    return out


async def feed(minutes: int, limit: int) -> list[FeedItem]:
    """Événements marquants récents, en phrases : ceux que le catalogue juge intéressants ou
    qu'un gabarit sait raconter (Wi-Fi, périphériques…). Le bruit connu est écarté."""
    page = await ev.search_events(minutes=minutes, limit=400)
    items: list[FeedItem] = []
    for e in page.items:
        if e.level == "Verbose":  # journalisation exhaustive (ex. tous les blocs PowerShell) : pas un fait marquant
            continue
        known = event_catalog.describe(e.channel, e.event_id)
        narrated = (event_catalog.family(e.channel), e.event_id) in event_narrator.TEMPLATES
        level = known["level"] if known else "info"
        if not narrated and level == "info":
            continue
        items.append(
            FeedItem(id=e.id, timestamp=e.timestamp, channel=e.channel, theme=event_catalog.theme_of(e.channel), event_id=e.event_id, title=e.title, summary=e.summary, level=level)
        )
    return fold_feed(items)[:limit]


# ─────────────────────────────── santé par journal
def os_channel_stats_body(since: datetime) -> dict:
    return {
        "size": 0,
        "aggs": {
            "channels": {
                "terms": {"field": "channel", "size": 50},
                "aggs": {
                    "last": {"max": {"field": "@timestamp"}},
                    "recent": {"filter": {"range": {"@timestamp": {"gte": since.isoformat()}}}},
                },
            }
        },
    }


async def channel_stats(now: datetime | None = None) -> dict[str, tuple[datetime | None, int]]:
    """Journal -> (dernier événement, nombre d'événements sur 24 h)."""
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(hours=24)
    if ev._use_sql():
        async with SessionLocal() as session:
            rows = await session.execute(
                select(Event.channel, func.max(Event.ts), func.sum(case((Event.ts >= since, 1), else_=0))).group_by(Event.channel)
            )
            return {channel: (_aware(last), int(recent or 0)) for channel, last, recent in rows.all()}
    res = await get_opensearch().search(index=ev.INDEX, body=os_channel_stats_body(since))
    out = {}
    for b in res["aggregations"]["channels"]["buckets"]:
        last = b["last"].get("value")
        out[b["key"]] = (datetime.fromtimestamp(last / 1000, tz=timezone.utc) if last else None, b["recent"]["doc_count"])
    return out


async def health() -> dict:
    return collection.assess(await channel_stats(), collection.heartbeats(), collection.sysmon_status(), winlog_collector.channel_status())


# ─────────────────────────────── chasses
async def hunt_counts(minutes: int) -> list[HuntOut]:
    out = []
    for h in hunts.HUNTS:
        n = await ev.count_events(channel=list(h.channels), event_id=list(h.event_ids), keywords=list(h.keywords), minutes=minutes)
        out.append(HuntOut(**hunts.as_dict(h), count=n))
    return out


def hunt_filters(hunt_id: str) -> dict | None:
    h = hunts.BY_ID.get(hunt_id)
    if h is None:
        return None
    return {"channel": list(h.channels), "event_id": list(h.event_ids), "keywords": list(h.keywords)}
