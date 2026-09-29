"""Couverture ATT&CK : réelle (sources collectées) vs théorique, plan de couverture."""

from app.services import attack
from app.services.attack import (
    RuleRef,
    available_sources,
    coverage,
    rules_for,
    source_of_channel,
)


def rule(i: int, source: str, *techniques: str, severity: str = "high") -> RuleRef:
    return RuleRef(id=f"r{i}", title=f"Règle {i}", severity=severity, source=source, origin="sigma", techniques=techniques)


RULES = [
    rule(1, "Sysmon", "T1003.001"),
    rule(2, "Sysmon", "T1003.001", "T1055"),  # une règle, deux techniques : compte pour chacune
    rule(3, "PowerShell", "T1059.001"),
    rule(4, "Security", "T1110"),
    rule(5, "inert", "T1003.001"),  # jamais comptée
    rule(6, "any", "T1547.001"),
]


def tech(cov: dict, tid: str) -> dict:
    return next(t for t in cov["techniques"] if t["id"] == tid)


def test_donnees_attack_officielles():
    data = attack.attack_data()
    assert data["attack_version"] and len(data["techniques"]) > 400
    assert data["techniques"]["T1003.001"]["name"] == "OS Credential Dumping: LSASS Memory"
    assert "credential-access" in data["techniques"]["T1003.001"]["tactics"]
    assert data["tactics"][0]["id"] == "reconnaissance"


def test_effectif_vs_theorique_et_regle_multi_techniques():
    cov = coverage(RULES, available={"PowerShell"}, alerts={})
    lsass = tech(cov, "T1003.001")
    assert (lsass["theoretical"], lsass["effective"], lsass["inert"]) == (2, 0, 1)
    assert tech(cov, "T1055")["theoretical"] == 1  # la règle 2 compte aussi pour T1055
    assert tech(cov, "T1059.001")["effective"] == 1
    assert tech(cov, "T1547.001")["effective"] == 1  # source « any » : toujours active
    t = cov["totals"]
    assert (t["rules_theoretical"], t["rules_effective"], t["rules_inert"]) == (5, 2, 1)
    assert all(x["effective"] <= x["theoretical"] for x in cov["techniques"])


def test_toutes_les_sources_donnent_la_couverture_theorique():
    cov = coverage(RULES, available=set(attack.SOURCES), alerts={})
    assert all(t["effective"] == t["theoretical"] for t in cov["techniques"])
    assert cov["plan"] == []


def test_plan_trie_par_gain_et_techniques_observees_sans_regle():
    cov = coverage(RULES, available={"PowerShell"}, alerts={"T1003.001": (6, 6), "T1059.001": (2, 0)})
    assert [p["source"] for p in cov["plan"]] == ["Sysmon", "Security"]
    sysmon = cov["plan"][0]
    assert (sysmon["rules"], sysmon["techniques"]) == (2, 2)  # T1003.001 + T1055 deviendraient couvertes
    assert sysmon["how"] and "install-sysmon" in sysmon["how"]
    assert cov["observed_uncovered"] == ["T1003.001"]  # observée, aucune règle active
    assert tech(cov, "T1003.001")["alerts_open"] == 6


def test_tactiques_v19_et_quartier():
    cov = coverage(RULES, available=set(), alerts={})
    injection = tech(cov, "T1055")
    assert injection["tactics"][0] in ("privilege-escalation", "stealth")  # ordre de la kill chain
    assert injection["district"] == injection["tactics"][0]
    assert {t["id"] for t in cov["tactics"]} >= {"stealth", "defense-impairment"}


def test_regles_d_une_technique_avec_raison():
    out = rules_for(RULES, "T1003.001", available={"PowerShell"})
    assert [r["id"] for r in out] == ["r1", "r2", "r5"]
    assert out[0]["active"] is False and out[0]["reason"].startswith("Nécessite")
    assert out[2]["reason"] == "Télémétrie non collectable par DeTecTX"


def test_sources_collectees_depuis_la_sante():
    health = {
        "sysmon": {"running": False},
        "channels": [
            {"channel": "Security", "status": "missing"},
            {"channel": "Microsoft-Windows-PowerShell/Operational", "status": "ok"},
            {"channel": "System", "status": "stale"},
            {"channel": "Application", "status": "quiet"},
        ],
    }
    assert available_sources(health) == {"PowerShell", "System", "Application"}
    assert available_sources(None) == set()
    assert source_of_channel("Microsoft-Windows-Sysmon/Operational") == "Sysmon"
    assert source_of_channel("Security") == "Security" and source_of_channel(None) == "any"
