"""Page Événements : catalogue, chasses, santé de la collecte, relief horaire, lecteur, API.

Chaque test utilise sa propre base SQLite temporaire (NullPool : aucune connexion n'est
partagée entre boucles asyncio).
"""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.db import Base
from app.deps import get_current_user
from app.detection import event_catalog, hunts
from app.main import app
from app.models.alert import Alert
from app.models.user import Role, User
from app.schemas.events import IngestEvent
from app.services import collection, event_insights
from app.services import events as ev

NOW = datetime(2026, 9, 28, 12, 30, tzinfo=timezone.utc)
SYSMON_OFF = {"installed": False, "running": False, "service": None}
SYSMON_ON = {"installed": True, "running": True, "service": "Sysmon64"}


@pytest.fixture
def db(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'events.db'}", poolclass=NullPool)

    async def create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(create())
    maker = async_sessionmaker(engine, expire_on_commit=False)
    monkeypatch.setattr(ev, "SessionLocal", maker)
    monkeypatch.setattr(event_insights, "SessionLocal", maker)
    yield maker
    asyncio.run(engine.dispose())


def _event(channel: str, event_id: int, at: datetime, message: str = "", record_id: int | None = None) -> IngestEvent:
    return IngestEvent(timestamp=at, channel=channel, event_id=event_id, message=message, record_id=record_id, computer="BINGO", raw={"User": "essid"})


def _ingest(*events: IngestEvent) -> None:
    asyncio.run(ev.index_events(list(events)))


# ─────────────────────────────── catalogue et chasses
def test_catalog_families_and_lookup():
    assert event_catalog.family("Microsoft-Windows-Sysmon/Operational") == "Sysmon"
    assert event_catalog.family("Microsoft-Windows-PowerShell/Operational") == "PowerShell"
    assert event_catalog.describe("System", 7045)["attack"] == "T1543.003"
    assert event_catalog.describe("Security", 1102)["level"] == "high"
    assert event_catalog.describe("Security", 99999) is None
    assert event_catalog.describe("Security", None) is None


def test_hunts_are_well_formed():
    ids = [h.id for h in hunts.HUNTS]
    assert len(ids) == len(set(ids))
    for h in hunts.HUNTS:
        assert h.channels and h.event_ids and h.title and h.question
        assert set(h.requires) <= {"admin", "sysmon"}
        if "sysmon" in h.requires:
            assert all("Sysmon" in c for c in h.channels)


# ─────────────────────────────── santé de la collecte (pure)
def _beat(minutes_ago: int, admin: bool | None = True) -> collection.Heartbeat:
    return collection.Heartbeat("BINGO", NOW - timedelta(minutes=minutes_ago), "1.1", admin, 15)


def test_health_down_when_agent_silent():
    h = collection.assess({"System": (NOW - timedelta(hours=47), 0)}, _beat(47 * 60), SYSMON_ON, now=NOW)
    assert h["status"] == "down" and "47 h" in h["summary"]
    assert next(c for c in h["channels"] if c["channel"] == "System")["status"] == "stale"


def test_health_degraded_without_admin_or_sysmon():
    recent = {"System": (NOW - timedelta(minutes=5), 12)}
    h = collection.assess(recent, _beat(0, admin=False), SYSMON_OFF, now=NOW)
    assert h["status"] == "degraded" and "administrateur" in h["summary"] and "Sysmon" in h["summary"]
    sysmon_row = next(c for c in h["channels"] if "Sysmon" in c["channel"])
    assert sysmon_row["status"] == "missing" and sysmon_row["hint"]
    security = next(c for c in h["channels"] if c["channel"] == "Security")
    assert security["status"] == "missing" and "administrateur" in security["hint"]


def test_health_ok_and_quiet_channels():
    stats = {c: (NOW - timedelta(minutes=2), 3) for c, _ in collection.EXPECTED}
    stats["Application"] = (NOW - timedelta(days=3), 0)  # journal calme, agent vivant
    h = collection.assess(stats, _beat(0), SYSMON_ON, now=NOW)
    assert h["status"] == "ok" and h["agent"]["alive"]
    assert next(c for c in h["channels"] if c["channel"] == "Application")["status"] == "quiet"


def test_health_without_any_agent():
    h = collection.assess({}, None, SYSMON_ON, now=NOW)
    assert h["status"] == "down" and "Aucun agent" in h["summary"]


# ─────────────────────────────── relief horaire, chasses, lecteur (SQL)
def test_histogram_buckets_and_alert_beacons(db):
    now = datetime.now(timezone.utc)
    _ingest(
        _event("System", 7045, now - timedelta(minutes=5)),
        _event("System", 7036, now - timedelta(minutes=10)),
        _event("Security", 4625, now - timedelta(hours=3, minutes=1)),
        _event("Security", 4625, now - timedelta(hours=60)),  # hors fenêtre de 48 h
    )

    async def add_alert():
        async with db() as session:
            session.add(Alert(dedup_key="k", rule_id="r", rule_title="Force brute", severity="high", risk_score=70, mitre="T1110", channel="Security", event_id=4625, event_timestamp=now - timedelta(hours=3)))
            await session.commit()

    asyncio.run(add_alert())
    h = asyncio.run(event_insights.histogram(48))
    assert h.hours == 48 and h.channels == ["Security", "System"]  # ordre des journaux attendus
    assert h.counts["System"][-1] == 2 and sum(h.counts["Security"]) == 1
    assert h.alerts[0].channel == "Security" and h.alerts[0].severity == "high" and h.alerts[0].bin == 47 - 3


def test_hunt_filters_and_counts(db):
    now = datetime.now(timezone.utc)
    _ingest(
        _event("Microsoft-Windows-PowerShell/Operational", 4104, now, "powershell -enc SQBFAFgA"),
        _event("Microsoft-Windows-PowerShell/Operational", 4104, now, "Get-ChildItem"),
        _event("Security", 4625, now, "échec"),
    )
    counts = {h.id: h.count for h in asyncio.run(event_insights.hunt_counts(60))}
    assert counts["ps-suspicious"] == 1 and counts["logon-failures"] == 1 and counts["new-services"] == 0
    page = asyncio.run(ev.search_events(**event_insights.hunt_filters("ps-suspicious")))
    assert page.total == 1 and "-enc" in page.items[0].message


def test_event_reader_with_knowledge_and_linked_alert(db):
    now = datetime.now(timezone.utc)
    _ingest(_event("System", 7045, now, "Service installé : evil", record_id=4242))

    async def add_alert():
        async with db() as session:
            session.add(Alert(dedup_key="k2", rule_id="r2", rule_title="Service suspect", severity="critical", risk_score=90, mitre="T1543.003", channel="System", event_id=7045, event_record_id=4242))
            await session.commit()

    asyncio.run(add_alert())
    key = asyncio.run(ev.search_events(limit=1)).items[0].id
    detail = asyncio.run(event_insights.get_event(key))
    assert detail.knowledge["title"] == "Nouveau service installé"
    assert detail.fields == {"User": "essid"}
    assert [a.rule_title for a in detail.alerts] == ["Service suspect"]
    assert asyncio.run(event_insights.get_event("999999")) is None


def test_time_slice_filter_and_titles(db):
    now = datetime.now(timezone.utc).replace(minute=30, second=0, microsecond=0)
    _ingest(_event("System", 7045, now), _event("System", 7045, now - timedelta(hours=2)))
    hour = now.replace(minute=0)
    page = asyncio.run(ev.search_events(since=hour, until=hour + timedelta(hours=1)))
    assert page.total == 1 and page.items[0].title == "Nouveau service installé"


# ─────────────────────────────── requêtes OpenSearch (pures)
def test_opensearch_bodies():
    q = ev._os_query(["Security", "System"], [1102, 104], ["a"], 60)
    filters = q["bool"]["filter"]
    assert {"terms": {"channel": ["Security", "System"]}} in filters and {"terms": {"event_id": [1102, 104]}} in filters
    assert ev._os_query("System", 7045, [], None)["bool"]["filter"] == [{"term": {"channel": "System"}}, {"term": {"event_id": 7045}}]
    start = NOW - timedelta(hours=48)
    body = event_insights.os_histogram_body(start, NOW)
    assert body["aggs"]["hours"]["date_histogram"]["fixed_interval"] == "1h"
    assert "last" in event_insights.os_channel_stats_body(NOW)["aggs"]["channels"]["aggs"]


# ─────────────────────────────── API
@pytest.fixture
def client():
    user = User(email="analyst@test.local", role=Role.analyst, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: user
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_heartbeat_ingest(client, db, monkeypatch):
    monkeypatch.setattr(collection, "_beats", {})
    res = client.post("/events/ingest", json={"events": [], "agent": {"computer": "BINGO", "version": "1.1", "admin": True, "interval_sec": 15}})
    assert res.status_code == 200 and res.json()["indexed"] == 0
    beat = collection.latest_heartbeat()
    assert beat.computer == "BINGO" and beat.admin is True
    assert client.post("/events/ingest", json={"events": [], "agent": {"computer": "", "interval_sec": 0}}).status_code == 422


def test_api_validation_and_routes(client, db):
    assert client.get("/events", params={"hunt": "inconnue"}).status_code == 404
    assert client.get("/events/histogram", params={"hours": 1000}).status_code == 422
    assert client.get("/events/hunts").status_code == 200
    assert client.get("/events/health").json()["status"] in ("ok", "degraded", "down")
    assert client.get("/events/abc$def").status_code == 422
    assert client.get("/events/123456").status_code == 404
