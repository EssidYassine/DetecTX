"""Tests du triage des alertes et de la chronologie (base SQLite en mémoire, isolée)."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models.alert import Alert
from app.schemas.alerts import BulkTriage, CaseTriage, TriageUpdate
from app.services import alerts as svc


# ─────────────────────────────── règles métier du schéma
def test_cloturer_exige_une_resolution():
    with pytest.raises(ValidationError):
        TriageUpdate(status="closed")


def test_resolution_interdite_hors_cloture():
    with pytest.raises(ValidationError):
        TriageUpdate(status="ack", resolution="false_positive")


def test_statut_et_resolution_valides():
    assert TriageUpdate(status="closed", resolution="false_positive").resolution == "false_positive"
    assert TriageUpdate(status="new").resolution is None


def test_statut_inconnu_refuse():
    with pytest.raises(ValidationError):
        TriageUpdate(status="deleted")


@pytest.mark.parametrize("ids", [[], list(range(201))])
def test_triage_groupe_borne(ids):
    with pytest.raises(ValidationError):
        BulkTriage(ids=ids, status="ack")


# ─────────────────────────────── service (base en mémoire)
def _run(coro_factory):
    async def main():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        maker = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with maker() as session:
                return await coro_factory(session)
        finally:
            await engine.dispose()

    return asyncio.run(main())


def _alert(i: int, severity: str = "high", when: datetime | None = None) -> Alert:
    return Alert(
        dedup_key=f"k{i}",
        rule_id="r",
        rule_title=f"Règle {i}",
        severity=severity,
        risk_score=50,
        event_timestamp=when,
    )


def test_triage_trace_auteur_date_et_ids_manquants():
    async def scenario(session):
        session.add_all([_alert(1), _alert(2)])
        await session.commit()
        result = await svc.triage_alerts(
            session, [1, 2, 2, 99], status="closed", resolution="false_positive", actor="analyste@local"
        )
        a1 = await session.get(Alert, 1)
        return result, a1

    result, a1 = _run(scenario)
    assert result.updated == 2
    assert result.missing == [99]  # doublons ignorés, id inexistant signalé
    assert a1.status == "closed"
    assert a1.resolution == "false_positive"
    assert a1.triaged_by == "analyste@local"
    assert a1.triaged_at is not None


def test_rouvrir_efface_la_resolution():
    async def scenario(session):
        session.add(_alert(1))
        await session.commit()
        await svc.triage_alerts(session, [1], status="closed", resolution="benign", actor="a")
        await svc.triage_alerts(session, [1], status="new", resolution=None, actor="b")
        return await session.get(Alert, 1)

    a = _run(scenario)
    assert (a.status, a.resolution, a.triaged_by) == ("new", None, "b")


def test_stats_par_statut():
    async def scenario(session):
        session.add_all([_alert(1), _alert(2), _alert(3)])
        await session.commit()
        await svc.triage_alerts(session, [3], status="ack", resolution=None, actor="a")
        return await svc.alerts_stats(session)

    assert _run(scenario).by_status == {"new": 2, "ack": 1}


def test_chronologie_jours_locaux_et_severites():
    now = datetime.now(timezone.utc)

    async def scenario(session):
        session.add_all([
            _alert(1, "critical", now - timedelta(minutes=5)),
            _alert(2, "high", now - timedelta(days=2)),
            _alert(3, "high", now - timedelta(days=2, minutes=1)),
            _alert(4, "low", now - timedelta(days=40)),  # hors fenêtre de 30 jours
        ])
        await session.commit()
        return await svc.alerts_timeline(session, days=30, tz_offset_min=0)

    tl = _run(scenario)
    assert len(tl.days) == 30
    assert tl.days[-1].date == now.date()  # le dernier jour est aujourd'hui
    assert sum(d.critical for d in tl.days) == 1
    assert sum(d.high for d in tl.days) == 2
    assert sum(d.low for d in tl.days) == 0  # l'alerte de J-40 est exclue


def test_filtre_de_periode_sur_la_liste():
    now = datetime.now(timezone.utc)

    async def scenario(session):
        session.add_all([_alert(1, when=now - timedelta(days=1)), _alert(2, when=now - timedelta(days=10))])
        await session.commit()
        return await svc.list_alerts(session, since=now - timedelta(days=3))

    page = _run(scenario)
    assert page.total == 1 and page.items[0].id == 1


# ─────────────────────────────── dossiers (alertes regroupées par règle)
def _rule_alert(i: int, rule: str, severity: str, *, mitre: str | None = None, risk: int = 50, when: datetime | None = None, message: str = "") -> Alert:
    return Alert(dedup_key=f"d{i}", rule_id=rule, rule_title=f"Titre {rule}", severity=severity, risk_score=risk, mitre=mitre, event_timestamp=when, message=message)


def test_dossiers_regroupes_par_regle_et_tries():
    now = datetime.now(timezone.utc)

    async def scenario(session):
        session.add_all([
            _rule_alert(1, "mimi", "critical", mitre="T1003.001", risk=90, when=now - timedelta(hours=3), message="ancien"),
            _rule_alert(2, "mimi", "critical", mitre="T1003.001", risk=90, when=now - timedelta(hours=1), message="récent"),
            _rule_alert(3, "ps", "high", mitre="T1059.001", risk=70, when=now - timedelta(minutes=5)),
            _rule_alert(4, "old", "critical", risk=95, when=now - timedelta(days=2)),
        ])
        await session.commit()
        await svc.triage_alerts(session, [4], status="closed", resolution="false_positive", actor="a")
        return await svc.list_cases(session)

    page = _run(scenario)
    assert [c.rule_id for c in page.cases] == ["mimi", "ps", "old"]  # dossier clos en dernier
    mimi = page.cases[0]
    assert (mimi.count, mimi.severity, mimi.risk) == (2, "critical", 90)
    assert mimi.by_status == {"new": 2, "ack": 0, "closed": 0}
    assert mimi.tactic == "credential-access" and mimi.latest_message == "récent"
    assert mimi.first_seen < mimi.last_seen and mimi.last_seen.tzinfo is not None
    s = page.summary
    assert (s.open_alerts, s.open_cases, s.open_critical, s.closed, s.false_positive) == (3, 2, 2, 1, 1)
    assert "credential-access" in s.tactics_hit and s.mean_triage_minutes is not None


def test_dossiers_filtres_ouverts_et_recherche_litterale():
    async def scenario(session):
        session.add_all([
            _rule_alert(1, "a", "high", message=r"C:\Temp\100%_evil.exe"),
            _rule_alert(2, "b", "high", message=r"C:\Temp\1000_evil.exe"),
        ])
        await session.commit()
        await svc.triage_alerts(session, [2], status="ack", resolution=None, actor="a")
        opened = await svc.list_cases(session, status="open")
        literal = await svc.list_cases(session, q="100%_")
        return opened, literal

    opened, literal = _run(scenario)
    assert {c.rule_id for c in opened.cases} == {"a", "b"}  # ouvert = nouvelles + en cours
    assert [c.rule_id for c in literal.cases] == ["a"]  # % et _ ne sont pas des jokers


def test_triage_dossier_ne_touche_que_les_statuts_concernes():
    async def scenario(session):
        session.add_all([_rule_alert(i, "r1", "high") for i in range(1, 4)] + [_rule_alert(9, "r2", "high")])
        await session.commit()
        await svc.triage_alerts(session, [3], status="closed", resolution="benign", actor="a")
        ack = await svc.triage_case(session, "r1", status="ack", resolution=None, actor="analyste")
        closed = await svc.triage_case(session, "r1", status="closed", resolution="true_positive", actor="analyste")
        unknown = await svc.triage_case(session, "nope", status="ack", resolution=None, actor="analyste")
        rows = {a.dedup_key: (a.status, a.resolution) for a in (await session.scalars(select(Alert))).all()}
        return ack, closed, unknown, rows

    ack, closed, unknown, rows = _run(scenario)
    assert ack.updated == 2  # la 3e était déjà close
    assert closed.updated == 2  # la close « bénin » garde sa conclusion
    assert rows["d3"] == ("closed", "benign") and rows["d1"] == ("closed", "true_positive")
    assert rows["d9"] == ("new", None)  # l'autre dossier est intact
    assert unknown is None


@pytest.mark.parametrize("rule_id", ["", "a b", "x" * 121, "../etc", "r;drop"])
def test_triage_dossier_identifiant_valide(rule_id):
    with pytest.raises(ValidationError):
        CaseTriage(rule_id=rule_id, status="ack")


def test_filtre_par_regle():
    async def scenario(session):
        session.add_all([_rule_alert(1, "r1", "high"), _rule_alert(2, "r2", "low")])
        await session.commit()
        return await svc.list_alerts(session, rule_id="r2")

    page = _run(scenario)
    assert page.total == 1 and page.items[0].rule_id == "r2"
