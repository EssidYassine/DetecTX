"""Posture du poste : calcul pur des 5 piliers (sans Windows) + décodage du Centre de sécurité."""

from datetime import datetime, timedelta, timezone

import pytest

from app.schemas.alerts import AlertCase
from app.services import posture
from app.services.posture import Inputs, evaluate
from app.services.security_center import Defense, Product, decode_state

NOW = datetime(2026, 9, 28, 12, 0, tzinfo=timezone.utc)
AVAST = Product("Avast Antivirus", "antivirus", active=True, up_to_date=True)
DEFENDER_PASSIVE = Product("Windows Defender", "antivirus", active=False, up_to_date=True)
GOOD_DEFENSE = Defense(available=True, products=(AVAST, DEFENDER_PASSIVE))
HEALTH_OK = {
    "status": "ok",
    "summary": "",
    "collectors": [{"alive": True}],
    "sysmon": {"installed": True, "running": True},
    "channels": [{"channel": "Security", "label": "Sécurité", "status": "ok"}],
}
HOST_OK = {"cpu_percent": 12.0, "ram_percent": 40.0, "disks": [{"mount": "C:\\", "percent": 50.0}]}


def exposure_state(*ports: tuple, enabled: bool = True) -> dict:
    return {
        "available": True,
        "profiles": {"active": ["public"], "states": {"public": {"enabled": enabled}}},
        "ports": [
            {"proto": proto, "port": port, "verdict": verdict, "reason": "Autorisé par « Node.js »", "risk": {"level": level, "service": "svc", "why": "…"}}
            for proto, port, verdict, level in ports
        ],
    }


def case(rule: str, severity: str, *, count: int = 1, new: int | None = None, closed: int = 0) -> AlertCase:
    opened = count - closed if new is None else new
    return AlertCase(
        rule_id=rule, rule_title=f"Règle {rule}", severity=severity, risk=90, mitre="T1003.001", mitre_name=None, tactic="credential-access",
        tactic_fr="Accès aux identifiants", count=count, by_status={"new": opened, "ack": 0, "closed": closed},
        first_seen=NOW - timedelta(days=1), last_seen=NOW - timedelta(hours=1), latest_id=1, latest_message=None, channels=[],
    )


def inputs(**over) -> Inputs:
    base = {"now": NOW, "cases": [], "exposure": exposure_state(), "defense": GOOD_DEFENSE, "visibility": HEALTH_OK, "host": HOST_OK}
    return Inputs(**{**base, **over})


def pillar(p, key):
    return next(x for x in p.pillars if x.key == key)


def test_tout_va_bien():
    p = evaluate(inputs())
    assert (p.score, p.tone, p.verdict) == (100, "ok", "Sous contrôle")
    assert p.priorities == []
    assert p.summary.startswith("Tout est en ordre")


def test_un_dossier_repete_compte_une_fois_et_les_clos_ne_comptent_plus():
    once = evaluate(inputs(cases=[case("mimi", "high", count=1)]))
    five = evaluate(inputs(cases=[case("mimi", "high", count=5)]))
    closed = evaluate(inputs(cases=[case("old", "critical", count=3, closed=3)]))
    assert pillar(once, "threats").score == pillar(five, "threats").score == 88
    assert pillar(closed, "threats").score == 100 and closed.tone == "ok"


def test_le_pire_pilier_plafonne_le_verdict():
    p = evaluate(inputs(cases=[case("mimi", "critical")]))
    assert pillar(p, "threats").tone == "critical"
    assert p.score <= 39 and p.verdict == "Action requise"
    assert p.priorities[0].id == "case:mimi" and p.priorities[0].href == "/dashboard/alerts?case=mimi"
    assert "Menaces" in p.summary and "Solide" in p.summary


def test_exposition_ports_dedoublonnes_et_ignore_les_bloques():
    exp = exposure_state(("tcp", 3389, "open", "critical"), ("udp", 5353, "open", "medium"), ("udp", 5353, "open", "medium"), ("tcp", 445, "blocked", "high"), ("tcp", 80, "open", "info"))
    ex = pillar(evaluate(inputs(exposure=exp)), "exposure")
    assert ex.score == 100 - 40 - 6
    assert ex.tone == "critical"
    assert [f.id for f in ex.findings] == ["port:tcp:3389", "port:udp:5353"]


def test_pare_feu_coupe_rend_la_defense_critique():
    d = pillar(evaluate(inputs(exposure=exposure_state(enabled=False))), "defense")
    assert d.tone == "critical" and d.score == 50
    assert any(f.id == "fw:public" and f.level == "critical" for f in d.findings)


def test_aucun_antivirus_actif():
    d = pillar(evaluate(inputs(defense=Defense(available=True, products=(DEFENDER_PASSIVE,)))), "defense")
    assert (d.score, d.tone) == (0, "critical")
    assert d.findings[0].title == "Aucun antivirus actif"


def test_defender_passif_explique_quand_un_tiers_protege():
    d = pillar(evaluate(inputs()), "defense")
    assert d.tone == "ok"
    assert any(f.id == "av:defender-passive" and "Avast" in (f.detail or "") for f in d.findings)


def test_visibilite_partielle_et_arretee():
    partial = dict(HEALTH_OK, sysmon={"installed": False, "running": False}, channels=[{"channel": "Security", "label": "Sécurité", "status": "missing", "hint": "admin requis"}, {"channel": "Microsoft-Windows-Sysmon/Operational", "label": "Sysmon", "status": "missing"}])
    v = pillar(evaluate(inputs(visibility=partial)), "visibility")
    assert (v.score, v.tone) == (55, "warn")
    down = pillar(evaluate(inputs(visibility=dict(HEALTH_OK, status="down"))), "visibility")
    assert (down.score, down.tone) == (0, "critical")


def test_sante_disque():
    h = pillar(evaluate(inputs(host=dict(HOST_OK, disks=[{"mount": "C:\\", "percent": 87.1}]))), "health")
    assert (h.score, h.tone) == (75, "warn") and "87 %" in h.findings[0].title
    full = pillar(evaluate(inputs(host=dict(HOST_OK, disks=[{"mount": "C:\\", "percent": 97.0}]))), "health")
    assert full.tone == "critical"


def test_source_en_panne_donne_un_pilier_inconnu_sans_casser_le_score():
    p = evaluate(inputs(exposure=None, defense=None))
    assert pillar(p, "exposure").tone == "unknown" and pillar(p, "exposure").score is None
    assert pillar(p, "defense").tone == "unknown"
    assert p.score == 100  # moyenne sur les piliers connus seulement
    assert evaluate(Inputs(now=NOW, cases=None, exposure=None, defense=None, visibility=None, host=None)).tone == "unknown"


def test_priorites_variees_et_triees():
    cases = [case(f"h{i}", "high") for i in range(6)]
    exp = exposure_state(("tcp", 3389, "open", "critical"))
    partial = dict(HEALTH_OK, sysmon={"installed": False, "running": False})
    p = evaluate(inputs(cases=cases, exposure=exp, visibility=partial))
    pillars = [f.pillar for f in p.priorities]
    assert p.priorities[0].id == "port:tcp:3389"  # le plus grave d'abord
    assert pillars.count("threats") == 2  # 2 constats max par pilier : les autres familles restent visibles
    assert "visibility" in pillars


@pytest.mark.parametrize(
    ("state", "expected"),
    [(0x041000, (True, True)), (0x060100, (False, True)), (0x041010, (True, False)), (0x040100, (False, True)), (0x041100, (True, True))],
)
def test_decodage_product_state(state, expected):
    assert decode_state(state) == expected


def test_collect_survit_aux_sources_en_panne(monkeypatch):
    import asyncio

    from app.services import alerts as alerts_svc
    from app.services import event_insights, firewall, metrics, security_center

    def boom(*_a, **_k):
        raise RuntimeError("panne")

    async def aboom(*_a, **_k):
        raise RuntimeError("panne")

    for mod, name in ((firewall, "exposure"), (security_center, "defense"), (metrics, "snapshot")):
        monkeypatch.setattr(mod, name, boom)
    monkeypatch.setattr(event_insights, "health", aboom)
    monkeypatch.setattr(alerts_svc, "list_cases", aboom)
    p = asyncio.run(posture.collect(session=None))
    assert p.tone == "unknown" and all(x.score is None for x in p.pillars)


def test_posture_cache_evite_les_recalculs(monkeypatch):
    import asyncio

    calls = []

    async def fake_collect(session):
        calls.append(1)
        return evaluate(inputs())

    monkeypatch.setattr(posture, "collect", fake_collect)
    monkeypatch.setattr(posture, "_cache", None)
    first = asyncio.run(posture.cached(None))
    second = asyncio.run(posture.cached(None))
    assert first is second and len(calls) == 1
    monkeypatch.setattr(posture, "_cache", (posture.time.monotonic() - posture.CACHE_TTL - 1, first))  # expiré
    asyncio.run(posture.cached(None))
    assert len(calls) == 2
