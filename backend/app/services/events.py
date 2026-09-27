"""Accès aux événements — backend OpenSearch (défaut) ou SQL local (sans Docker).

Le backend est choisi par settings.events_backend ("opensearch" | "sql").
Le mode SQL permet de faire tourner toute la chaîne (collecte → détection →
alertes → dashboard) sur un poste sans Docker.
"""

from datetime import datetime, timedelta, timezone

from opensearchpy.helpers import async_bulk
from sqlalchemy import func, or_, select

from app.clients import get_opensearch
from app.config import get_settings
from app.db import SessionLocal
from app.detection.event_catalog import CATALOG, family
from app.models.event import Event
from app.schemas.events import EventOut, EventPage, EventStats, IngestEvent

settings = get_settings()
INDEX = "detectx-events"


def _use_sql() -> bool:
    return settings.events_backend == "sql"


# ─────────────────────────── OpenSearch template ───────────────────────────
_TEMPLATE = {
    "index_patterns": [f"{INDEX}*"],
    "template": {
        "settings": {"number_of_shards": 1, "number_of_replicas": 0},
        "mappings": {
            "properties": {
                "@timestamp": {"type": "date"},
                "channel": {"type": "keyword"},
                "event_id": {"type": "integer"},
                "provider": {"type": "keyword"},
                "computer": {"type": "keyword"},
                "level": {"type": "keyword"},
                "record_id": {"type": "long"},
                "message": {"type": "text"},
                "raw": {"type": "object", "enabled": False},
            }
        },
    },
}


async def ensure_events_index() -> None:
    """Prépare le stockage des événements (no-op en mode SQL : tables via create_all)."""
    if _use_sql():
        return
    client = get_opensearch()
    await client.indices.put_index_template(name=INDEX, body=_TEMPLATE)
    if not await client.indices.exists(index=INDEX):
        await client.indices.create(index=INDEX)


def _utc(dt: datetime) -> datetime:
    return dt.astimezone(timezone.utc)


# ─────────────────────────────── Ingestion ────────────────────────────────
async def index_events(events: list[IngestEvent]) -> int:
    if _use_sql():
        async with SessionLocal() as session:
            for e in events:
                session.add(
                    Event(
                        ts=_utc(e.timestamp),
                        channel=e.channel,
                        event_id=e.event_id,
                        provider=e.provider,
                        computer=e.computer,
                        level=e.level,
                        record_id=e.record_id,
                        message=e.message,
                        fields=e.raw or {},
                    )
                )
            await session.commit()
        return len(events)

    client = get_opensearch()
    actions = [
        {
            "_index": INDEX,
            "_source": {
                "@timestamp": _utc(e.timestamp).isoformat(),
                "channel": e.channel,
                "event_id": e.event_id,
                "provider": e.provider,
                "computer": e.computer,
                "level": e.level,
                "record_id": e.record_id,
                "message": e.message,
                "raw": e.raw,
            },
        }
        for e in events
    ]
    indexed, _ = await async_bulk(client, actions)
    return indexed


# ───────────────────────── Lecture (endpoint /events) ──────────────────────
async def search_events(
    *,
    channel: str | list[str] | None = None,
    event_id: int | list[int] | None = None,
    q: str | None = None,
    keywords: list[str] | None = None,
    minutes: int | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    offset: int = 0,
    limit: int = 50,
) -> EventPage:
    """`q` : texte libre saisi ; `keywords` : mots-clés d'une chasse (au moins un doit figurer).
    Les deux se combinent : ET entre `q` et le groupe de mots-clés."""
    if _use_sql():
        async with SessionLocal() as session:
            conds = _sql_conditions(channel, event_id, keywords or [], minutes, phrase=True)
            if q:
                conds.append(Event.message.ilike(f"%{q}%"))
            if since is not None:
                conds.append(Event.ts >= _utc(since))
            if until is not None:
                conds.append(Event.ts < _utc(until))
            total = await session.scalar(select(func.count()).select_from(Event).where(*conds))
            rows = (
                await session.scalars(
                    select(Event).where(*conds).order_by(Event.ts.desc()).offset(offset).limit(limit)
                )
            ).all()
            return EventPage(total=total or 0, items=[_row_to_out(r) for r in rows])

    query = _os_query(channel, event_id, keywords or [], minutes)
    if q:
        query["bool"].setdefault("must", []).append({"match_phrase": {"message": q}})
    if since is not None or until is not None:
        bounds = {k: _utc(v).isoformat() for k, v in (("gte", since), ("lt", until)) if v is not None}
        query["bool"]["filter"].append({"range": {"@timestamp": bounds}})
    body = {
        "query": query,
        "sort": [{"@timestamp": {"order": "desc"}}],
        "from": offset,
        "size": limit,
        "track_total_hits": True,
    }
    res = await get_opensearch().search(index=INDEX, body=body)
    hits = res["hits"]
    return EventPage(
        total=hits["total"]["value"],
        items=[_src_to_out(h) for h in hits["hits"]],
    )


async def events_stats() -> EventStats:
    since = datetime.now(timezone.utc) - timedelta(hours=24)
    if _use_sql():
        async with SessionLocal() as session:
            total = await session.scalar(select(func.count()).select_from(Event)) or 0
            last_24h = (
                await session.scalar(
                    select(func.count()).select_from(Event).where(Event.ts >= since)
                )
                or 0
            )
            rows = await session.execute(
                select(Event.channel, func.count()).group_by(Event.channel)
            )
            return EventStats(
                total=total, last_24h=last_24h, by_channel={c: n for c, n in rows.all()}
            )

    body = {
        "size": 0,
        "track_total_hits": True,
        "aggs": {
            "by_channel": {"terms": {"field": "channel", "size": 20}},
            "last_24h": {"filter": {"range": {"@timestamp": {"gte": since.isoformat()}}}},
        },
    }
    res = await get_opensearch().search(index=INDEX, body=body)
    return EventStats(
        total=res["hits"]["total"]["value"],
        last_24h=res["aggregations"]["last_24h"]["doc_count"],
        by_channel={
            b["key"]: b["doc_count"] for b in res["aggregations"]["by_channel"]["buckets"]
        },
    )


# ───────────────────── API pour le moteur de détection ─────────────────────
async def query_events(
    *,
    channel: str | list[str] | None,
    event_id: int | list[int] | None,
    keywords: list[str],
    minutes: int | None,
    limit: int,
) -> list[dict]:
    """Retourne les événements correspondant aux critères d'une règle."""
    if _use_sql():
        async with SessionLocal() as session:
            conds = _sql_conditions(channel, event_id, keywords, minutes, phrase=False)
            rows = (
                await session.scalars(
                    select(Event).where(*conds).order_by(Event.ts.desc()).limit(limit)
                )
            ).all()
            return [
                {
                    "channel": r.channel,
                    "event_id": r.event_id,
                    "record_id": r.record_id,
                    "timestamp": r.ts,
                    "message": r.message,
                    "fields": r.fields or {},
                }
                for r in rows
            ]

    body = {"query": _os_query(channel, event_id, keywords, minutes), "size": limit}
    res = await get_opensearch().search(index=INDEX, body=body)
    out = []
    for h in res["hits"]["hits"]:
        s = h["_source"]
        out.append(
            {
                "channel": s.get("channel"),
                "event_id": s.get("event_id"),
                "record_id": s.get("record_id") or h["_id"],
                "timestamp": s.get("@timestamp"),
                "message": s.get("message"),
                "fields": s.get("raw") or {},
            }
        )
    return out


async def count_events(
    *, channel: str | list[str] | None, event_id: int | list[int] | None, keywords: list[str], minutes: int | None
) -> int:
    if _use_sql():
        async with SessionLocal() as session:
            conds = _sql_conditions(channel, event_id, keywords, minutes, phrase=False)
            return await session.scalar(select(func.count()).select_from(Event).where(*conds)) or 0

    res = await get_opensearch().count(
        index=INDEX, body={"query": _os_query(channel, event_id, keywords, minutes)}
    )
    return res["count"]


# ─────────────────────────────── Helpers ──────────────────────────────────
def _as_list(value) -> list:
    """None -> [] ; valeur -> [valeur] ; liste -> liste (sans les vides)."""
    if value is None:
        return []
    values = value if isinstance(value, (list, tuple)) else [value]
    return [v for v in values if v is not None and v != ""]


def _os_query(channel, event_id, keywords, minutes) -> dict:
    filters: list[dict] = []
    channels, ids = _as_list(channel), _as_list(event_id)
    if channels:
        filters.append({"terms": {"channel": channels}} if len(channels) > 1 else {"term": {"channel": channels[0]}})
    if ids:
        filters.append({"terms": {"event_id": ids}} if len(ids) > 1 else {"term": {"event_id": ids[0]}})
    if minutes is not None:
        filters.append({"range": {"@timestamp": {"gte": f"now-{minutes}m"}}})
    bool_q: dict = {"filter": filters}
    kws = [k for k in keywords if k]
    if kws:
        bool_q["should"] = [{"match_phrase": {"message": k}} for k in kws]
        bool_q["minimum_should_match"] = 1
    return {"bool": bool_q}


def _sql_conditions(channel, event_id, keywords, minutes, *, phrase: bool):
    conds = []
    channels, ids = _as_list(channel), _as_list(event_id)
    if channels:
        conds.append(Event.channel.in_(channels) if len(channels) > 1 else Event.channel == channels[0])
    if ids:
        conds.append(Event.event_id.in_(ids) if len(ids) > 1 else Event.event_id == ids[0])
    if minutes is not None:
        since = datetime.now(timezone.utc) - timedelta(minutes=minutes)
        conds.append(Event.ts >= since)
    kws = [k for k in keywords if k]
    if kws:
        conds.append(or_(*[Event.message.ilike(f"%{k}%") for k in kws]))
    return conds


def _title(channel: str | None, event_id: int | None) -> str | None:
    known = CATALOG.get((family(channel), event_id)) if event_id is not None else None
    return known.title if known else None


def _row_to_out(r: Event) -> EventOut:
    return EventOut(
        id=str(r.id),
        title=_title(r.channel, r.event_id),
        timestamp=r.ts,
        channel=r.channel,
        event_id=r.event_id,
        provider=r.provider,
        computer=r.computer,
        level=r.level,
        record_id=r.record_id,
        message=r.message,
    )


def _src_to_out(hit: dict) -> EventOut:
    s = hit["_source"]
    return EventOut(
        id=str(hit["_id"]),
        title=_title(s.get("channel"), s.get("event_id")),
        timestamp=s["@timestamp"],
        channel=s.get("channel", "unknown"),
        event_id=s.get("event_id"),
        provider=s.get("provider"),
        computer=s.get("computer"),
        level=s.get("level"),
        record_id=s.get("record_id"),
        message=s.get("message"),
    )
