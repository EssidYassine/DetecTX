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


def test_catalog_checks_provider_for_shared_ids():
    # ID 1000 du journal Application : plantage pour « Application Error », simple message pour VMware.
    assert event_catalog.lookup("Application", 1000, "Application Error").title == "Plantage d'application"
    assert event_catalog.lookup("Application", 1000, "vmauthd") is None
    assert event_catalog.lookup("Application", 1000) is not None  # fournisseur inconnu : on garde la fiche
    assert event_catalog.lookup("System", 7045, "anything") is not None  # IDs non partagés : fournisseur ignoré


def test_hunts_are_well_formed():
    ids = [h.id for h in hunts.HUNTS]
    assert len(ids) == len(set(ids))
    for h in hunts.HUNTS:
        assert h.channels and h.event_ids and h.title and h.question
        assert set(h.requires) <= {"admin", "sysmon"}
        if "sysmon" in h.requires:
            assert all("Sysmon" in c for c in h.channels)


# ─────────────────────────────── santé de la collecte (pure)
def _beat(minutes_ago: int, admin: bool | None = True, kind: str = "integre") -> collection.Heartbeat:
    return collection.Heartbeat("BINGO", kind, NOW - timedelta(minutes=minutes_ago), "1.1", admin, 15)


def test_health_down_when_no_collector_alive():
    h = collection.assess({"System": (NOW - timedelta(hours=47), 0)}, [_beat(47 * 60)], SYSMON_ON, now=NOW)
    assert h["status"] == "down" and "47 h" in h["summary"]
    assert next(c for c in h["channels"] if c["channel"] == "System")["status"] == "stale"


def test_health_degraded_without_admin_or_sysmon():
    recent = {"System": (NOW - timedelta(minutes=5), 12)}
    h = collection.assess(recent, [_beat(0, admin=False)], SYSMON_OFF, now=NOW)
    assert h["status"] == "degraded" and "administrateur" in h["summary"] and "Sysmon" in h["summary"]
    sysmon_row = next(c for c in h["channels"] if "Sysmon" in c["channel"])
    assert sysmon_row["status"] == "missing" and sysmon_row["hint"]
    security = next(c for c in h["channels"] if c["channel"] == "Security")
    assert security["status"] == "missing" and "administrateur" in security["hint"]


def test_health_ok_quiet_and_readability():
    stats = {c: (NOW - timedelta(minutes=2), 3) for c, _ in collection.EXPECTED}
    stats["Application"] = (NOW - timedelta(days=3), 0)  # journal calme, collecteur vivant
    del stats["Microsoft-Windows-TaskScheduler/Operational"]  # lisible mais vide
    readable = {"Microsoft-Windows-TaskScheduler/Operational": "ok", "Microsoft-Windows-WMI-Activity/Operational": "denied"}
    del stats["Microsoft-Windows-WMI-Activity/Operational"]
    h = collection.assess(stats, [_beat(0, kind="integre", admin=False), _beat(0, kind="agent", admin=True)], SYSMON_ON, readable, now=NOW)
    assert h["status"] == "ok" and len(h["collectors"]) == 2  # l'agent admin couvre le journal Sécurité
    row = {c["channel"]: c for c in h["channels"]}
    assert row["Application"]["status"] == "quiet"
    assert row["Microsoft-Windows-TaskScheduler/Operational"]["status"] == "quiet"
    assert row["Microsoft-Windows-WMI-Activity/Operational"]["status"] == "missing"


def test_health_without_any_collector():
    h = collection.assess({}, [], SYSMON_ON, now=NOW)
    assert h["status"] == "down" and "Aucun collecteur" in h["summary"]


# ─────────────────────────────── narrateur (phrases lisibles)
def test_narrator_uses_real_fields_and_falls_back():
    from app.detection.event_narrator import summarize

    wifi = "Microsoft-Windows-WLAN-AutoConfig/Operational"
    assert summarize(wifi, 8001, {"SSID": "Maison"}, None) == "Connecté au Wi-Fi « Maison »"
    fw = "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
    s = summarize(fw, 2097, {"RuleName": "Node.js", "ApplicationPath": r"C:\Program Files\nodejs\node.exe"}, None)
    assert s.startswith("Règle de pare-feu ajoutée : Node.js")
    # Champ manquant : aucune invention, repli sur la 1re ligne du message.
    assert summarize(wifi, 8001, {}, "Service WLAN connecté.\nDétails…") == "Service WLAN connecté."
    ps = summarize("Windows PowerShell", 400, {}, "Engine state…\n\tHostApplication=powershell.exe -enc AAA\n")
    assert ps == "PowerShell démarré : powershell.exe -enc AAA"
    full = summarize("Windows PowerShell", 400, {}, "HostApplication=C:\\WINDOWS\\System32\\powershell.exe -NoProfile\n")
    assert full == "PowerShell démarré : powershell.exe -NoProfile"  # sans le dossier de l'exécutable
    script = summarize("Microsoft-Windows-PowerShell/Operational", 4104, {"ScriptBlockText": "Get-Item C:\\x " + "a" * 200}, None)
    assert script.startswith("Script PowerShell : Get-Item")  # un script se lit par le début
    # Segment facultatif : une appli empaquetée n'a pas de chemin, la phrase reste valable sans.
    assert summarize(fw, 2097, {"RuleName": "Copilot", "ApplicationPath": ""}, "A rule has been added…") == "Règle de pare-feu ajoutée : Copilot"
    assert summarize(fw, 2052, {"RuleName": "Copilot", "ModifyingApplication": "-"}, None) == "Règle de pare-feu supprimée : Copilot"
    ci = summarize("Microsoft-Windows-CodeIntegrity/Operational", 3033, {"FileNameBuffer": r"\Device\HarddiskVolume3\Program Files\App\x.dll"}, None)
    assert ci == r"Signature non conforme : \Program Files\App\x.dll"  # chemin noyau rendu lisible
    # Le champ obligatoire, lui, reste exigé.
    assert summarize(fw, 2097, {"ApplicationPath": r"C:\x.exe"}, "A rule has been added…") == "A rule has been added…"


def test_feed_folds_bursts_of_identical_events():
    from app.schemas.events import FeedItem

    t0 = datetime(2026, 9, 28, 10, 7, 18, tzinfo=timezone.utc)
    fw = "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"

    def item(i: int, seconds: int, event_id: int, summary: str) -> FeedItem:
        return FeedItem(id=f"e{i}", timestamp=t0 - timedelta(seconds=seconds), channel=fw, theme="defense", event_id=event_id, title=None, summary=summary, level="medium")

    items = [  # du plus récent au plus ancien, rafales entrelacées comme dans le vrai journal
        item(1, 0, 2097, "ajoutée : Copilot"),
        item(2, 0, 2052, "supprimée : Copilot"),
        item(3, 1, 2097, "ajoutée : Copilot"),
        item(4, 1, 2052, "supprimée : Copilot"),
        item(5, 600, 2097, "ajoutée : Copilot"),  # 10 min plus tôt : un autre fait
    ]
    folded = event_insights.fold_feed(items)
    assert [(f.id, f.count) for f in folded] == [("e1", 2), ("e2", 2), ("e5", 1)]


# ─────────────────────────────── collecteur intégré (analyse XML, sans lire le poste)
WIN_XML = """<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System>
<Provider Name='Microsoft-Windows-WLAN-AutoConfig'/><EventID>8001</EventID><Level>4</Level>
<TimeCreated SystemTime='2026-09-27T21:49:03.1234567Z'/><EventRecordID>1234</EventRecordID>
<Channel>Microsoft-Windows-WLAN-AutoConfig/Operational</Channel><Computer>BINGO</Computer></System>
<EventData><Data Name='SSID'>Maison</Data><Data>sans nom</Data></EventData></Event>"""


def test_collector_parses_windows_xml():
    from app.services import winlog_collector as wc

    ev = wc.parse_event_xml(WIN_XML)
    assert ev["event_id"] == 8001 and ev["record_id"] == 1234 and ev["level"] == "Information"
    assert ev["fields"] == {"SSID": "Maison", "Data2": "sans nom"}
    assert ev["timestamp"].tzinfo is not None and ev["computer"] == "BINGO"
    src = wc.Source("X", (8001, 8003))
    assert wc._xpath(src, 99) == "*[System[(EventID=8001 or EventID=8003) and EventRecordID>99]]"
    assert "timediff" in wc._xpath(wc.Source("Y"), None)


def test_collector_state_roundtrip(tmp_path, monkeypatch):
    from app.services import winlog_collector as wc

    monkeypatch.setattr(wc.settings, "collector_state_path", str(tmp_path / "state.json"))
    wc.save_state({"System": 42})
    assert wc.load_state() == {"System": 42}


# ─────────────────────────────── relief horaire, chasses, lecteur (SQL)
def test_histogram_by_theme_and_alert_beacons(db):
    now = datetime.now(timezone.utc)
    _ingest(
        _event("System", 7045, now - timedelta(minutes=5)),
        _event("System", 7036, now - timedelta(minutes=10)),
        _event("Security", 4625, now - timedelta(hours=3, minutes=1)),
        _event("Microsoft-Windows-WLAN-AutoConfig/Operational", 8001, now - timedelta(minutes=2)),
        _event("Security", 4625, now - timedelta(hours=60)),  # hors fenêtre de 48 h
    )

    async def add_alert():
        async with db() as session:
            session.add(Alert(dedup_key="k", rule_id="r", rule_title="Force brute", severity="high", risk_score=70, mitre="T1110", channel="Security", event_id=4625, event_timestamp=now - timedelta(hours=3)))
            await session.commit()

    asyncio.run(add_alert())
    h = asyncio.run(event_insights.histogram(48))
    assert [lane.key for lane in h.lanes] == ["sessions", "defense", "execution", "network", "system", "apps"]
    assert h.counts["system"][-1] == 2 and sum(h.counts["sessions"]) == 1 and h.counts["network"][-1] == 1
    assert h.alerts[0].lane == "sessions" and h.alerts[0].severity == "high" and h.alerts[0].bin == 47 - 3


def test_ingest_is_idempotent(db):
    now = datetime.now(timezone.utc)
    first = _event("System", 7045, now, record_id=77)
    _ingest(first, _event("System", 7045, now, record_id=77))  # doublon dans le même lot
    _ingest(first)  # renvoyé plus tard (agent + collecteur intégré)
    assert asyncio.run(ev.search_events()).total == 1


def test_timestamps_leave_sqlite_in_utc(db):
    """SQLite perd le fuseau : sans correction, l'API sortait « 10:18 » sans « Z » et le navigateur
    affichait l'heure décalée (UTC lu comme local)."""
    at = datetime(2026, 9, 28, 12, 18, 22, tzinfo=timezone(timedelta(hours=2)))  # 10:18:22 UTC
    _ingest(_event("System", 7045, at, record_id=5))
    item = asyncio.run(ev.search_events()).items[0]
    assert item.timestamp == datetime(2026, 9, 28, 10, 18, 22, tzinfo=timezone.utc)
    assert item.model_dump_json().count("+00:00") + item.model_dump_json().count("Z") >= 1
    # La tranche horaire (bornes « aware ») retrouve bien l'événement.
    since = datetime(2026, 9, 28, 10, 0, tzinfo=timezone.utc)
    assert asyncio.run(ev.search_events(since=since, until=since + timedelta(hours=1))).total == 1


def test_keyword_search_is_literal(db):
    now = datetime.now(timezone.utc)
    _ingest(
        _event("DeTecTX-FileMonitor", 1, now, "CREATED C:\\Users\\x\\Startup\\evil.lnk"),
        _event("DeTecTX-FileMonitor", 1, now, "CREATED C:\\Users\\x\\Documents\\a_b.txt"),
    )
    assert asyncio.run(ev.search_events(keywords=["\\Startup\\"])).total == 1
    assert asyncio.run(ev.search_events(q="a_b")).total == 1
    assert asyncio.run(ev.search_events(q="a%b")).total == 0  # % n'est pas un joker


def test_feed_keeps_notable_events_as_sentences(db):
    now = datetime.now(timezone.utc)
    _ingest(
        _event("Microsoft-Windows-WLAN-AutoConfig/Operational", 8001, now, "x", record_id=1),
        _event("System", 10016, now, "bruit DCOM", record_id=2),  # bruit connu : écarté
    )
    items = asyncio.run(event_insights.feed(60, 10))
    assert [i.channel for i in items] == ["Microsoft-Windows-WLAN-AutoConfig/Operational"]
    assert items[0].theme == "network"


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
    beat = collection.heartbeats()[0]
    assert beat.computer == "BINGO" and beat.kind == "agent" and beat.admin is True
    assert client.post("/events/ingest", json={"events": [], "agent": {"computer": "", "interval_sec": 0}}).status_code == 422


def test_api_validation_and_routes(client, db):
    assert client.get("/events", params={"hunt": "inconnue"}).status_code == 404
    assert client.get("/events/histogram", params={"hours": 1000}).status_code == 422
    assert client.get("/events/hunts").status_code == 200
    assert client.get("/events/health").json()["status"] in ("ok", "degraded", "down")
    assert client.get("/events/abc$def").status_code == 422
    assert client.get("/events/123456").status_code == 404
    assert client.get("/events", params={"theme": "network"}).status_code == 200
    assert client.get("/events", params={"theme": "inconnu"}).status_code == 404
    assert client.get("/events/feed").status_code == 200


# ─────────────────────────────── journaux « muets » (éditeur sans modèle de message)
def test_fallback_message_and_session_phrases():
    from app.detection.event_narrator import fallback_message, summarize

    elan = {"Data1": "ELAN/Service", "Data2": "[ELAN Service] WTS_SESSION_UNLOCK"}
    assert fallback_message(elan, "ELAN/Service") == "[ELAN Service] WTS_SESSION_UNLOCK"  # sans répéter le fournisseur
    assert fallback_message({}, "x") is None and fallback_message({"Data1": " "}, None) is None
    assert summarize("Application", 14000, elan, None, "ELAN/Service") == "Session déverrouillée (signalé par ELAN)"
    lock = {"Data1": "[ELAN Service] WTS_SESSION_LOCK"}
    assert summarize("Application", 14000, lock, None, None) == "Session verrouillée"
    spotify = {"Data1": "Spotify SessionConnectedTask: Completed successfully"}
    assert summarize("Application", 1, spotify, None, "SpotifySessionConnectedTask") == "Spotify SessionConnectedTask: Completed successfully"


def test_repair_missing_messages_is_idempotent_and_searchable(db):
    now = datetime.now(timezone.utc)
    muted = IngestEvent(timestamp=now, channel="Application", event_id=14000, provider="ELAN/Service", message=None, record_id=1, computer="BINGO",
                        raw={"Data1": "ELAN/Service", "Data2": "[ELAN Service] WTS_SESSION_UNLOCK"})
    empty = IngestEvent(timestamp=now, channel="Application", event_id=14000, provider="ELAN/Service", message=None, record_id=2, computer="BINGO", raw={})
    _ingest(muted, empty)
    assert asyncio.run(ev.search_events(q="WTS_SESSION_UNLOCK")).total == 0  # invisible avant réparation
    assert asyncio.run(ev.repair_missing_messages()) == 1
    assert asyncio.run(ev.repair_missing_messages()) == 0  # idempotent ; l'événement sans valeurs reste vide
    page = asyncio.run(ev.search_events(q="WTS_SESSION_UNLOCK"))
    assert page.total == 1 and page.items[0].summary == "Session déverrouillée (signalé par ELAN)"


# ─────────────────────────────── règles créées depuis les journaux
@pytest.mark.parametrize(
    "bad",
    [
        {"title": "ok titre", "keywords": ["x"]},  # mot-clé trop court
        {"title": "ok titre", "keywords": ["a" * 201]},
        {"title": "ok titre", "keywords": [f"mot{i}" for i in range(11)]},  # plus de 10
        {"title": "ok titre", "event_id": 70000},
        {"title": "ok titre", "mitre": "T12"},
        {"title": "ok titre", "channel": "Security; DROP"},
        {"title": "ok titre", "event_id": 1, "threshold_count": 5},  # seuil incomplet
    ],
)
def test_rule_input_is_validated(bad):
    from pydantic import ValidationError

    from app.schemas.rules import RuleIn

    with pytest.raises(ValidationError):
        RuleIn(**bad)


def test_rule_input_is_normalised():
    from app.schemas.rules import RuleIn

    r = RuleIn(title="  Déverrouillage   poste ", keywords=[" WTS_SESSION_UNLOCK ", "wts_session_unlock", ""], mitre="", channel="")
    assert r.title == "Déverrouillage poste" and r.keywords == ["WTS_SESSION_UNLOCK"] and r.mitre is None and r.channel is None


def test_rule_preview_and_end_to_end_detection(db, monkeypatch):
    from app import notify
    from app.routers import rules as rules_router
    from app.schemas.rules import RuleIn
    from app.services import alerts as alerts_svc

    now = datetime.now(timezone.utc)
    events = [
        IngestEvent(timestamp=now - timedelta(minutes=i), channel="Application", event_id=14000, provider="ELAN/Service", message=None, record_id=100 + i,
                    computer="BINGO", raw={"Data1": "ELAN/Service", "Data2": f"[ELAN Service] {'WTS_SESSION_UNLOCK' if i % 2 == 0 else 'WTS_SESSION_LOCK'}"})
        for i in range(6)
    ]
    _ingest(*events)
    asyncio.run(ev.repair_missing_messages())

    payload = RuleIn(title="Déverrouillage du poste", level="low", channel="Application", event_id=14000, keywords=["WTS_SESSION_UNLOCK"])
    preview = asyncio.run(rules_router.preview_rule(payload, _=None))
    assert (preview.matches_24h, preview.matches_7d, preview.would_alert, preview.noisy) == (3, 3, 3, False)
    assert len(preview.samples) == 3 and preview.samples[0].summary.startswith("Session déverrouillée")

    threshold = RuleIn(title="Rafale", channel="Application", event_id=14000, threshold_count=10, threshold_minutes=60)
    assert asyncio.run(rules_router.preview_rule(threshold, _=None)).would_alert == 0  # 6 < 10

    monkeypatch.setattr(notify, "enabled", lambda: False)  # pas de notification Discord en test

    async def create_and_run():
        async with db() as session:
            await rules_router.create_rule(payload, session=session, _=None)
            result = await alerts_svc.run_detection(session)
            page = await alerts_svc.list_alerts(session, rule_id="custom-deverrouillage-du-poste")
            return result, page

    result, page = asyncio.run(create_and_run())
    assert page.total == 3 and result.alerts_created >= 3  # la règle se déclenche sur les messages réparés
