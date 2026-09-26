"""Tests du triage des alertes et de la chronologie (base SQLite en mémoire, isolée)."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from pydantic import ValidationError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models.alert import Alert
from app.schemas.alerts import BulkTriage, TriageUpdate
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
