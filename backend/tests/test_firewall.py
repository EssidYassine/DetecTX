"""Exposition des ports : croisement sockets × règles du pare-feu, et niveau de risque.

L'évaluation est testée sur des règles synthétiques (indépendantes du poste) ; un test de
fumée vérifie en plus la lecture réelle du pare-feu Windows quand elle est possible.
"""

import sys

import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.detection.port_risk import assess
from app.main import app
from app.models.user import Role, User
from app.services import firewall as fw

PUBLIC, PRIVATE = 4, 2
MYSQLD = r"C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqld.exe"


def state(*rules: fw.FwRule, active: int = PUBLIC, **overrides) -> fw.FwState:
    s = fw.FwState(
        available=True,
        active=active,
        enabled={1: True, 2: True, 4: True},
        default_block={1: True, 2: True, 4: True},
        block_all={1: False, 2: False, 4: False},
        rules=list(rules),
    )
    for key, value in overrides.items():
        setattr(s, key, value)
    return s


def rule(name="r", *, allow=True, profiles=PUBLIC, protocol=6, program=None, ports=None, **kw) -> fw.FwRule:
    any_port, spans, keywords = fw._parse_ports(ports or "*")
    return fw.FwRule(
        name=name,
        allow=allow,
        profiles=profiles,
        protocol=protocol,
        ports=spans,
        any_port=any_port,
        keywords=keywords,
        program=fw._norm_path(program) if program else None,
        **kw,
    )


def sock(port=3306, ip="0.0.0.0", exe=MYSQLD, pid=4588, proto="tcp", process="mysqld.exe") -> fw.Listener:
    return fw.Listener(proto, ip, port, pid, process, exe)


# ─────────────────────────────── évaluation
def test_loopback_is_local_whatever_the_rules():
    v = fw.evaluate(sock(ip="127.0.0.1"), state(rule(program=MYSQLD)), {})
    assert v.verdict == "local"


def test_no_rule_means_blocked_by_default():
    v = fw.evaluate(sock(), state(), {})
    assert v.verdict == "blocked" and "défaut" in v.reason


def test_program_rule_opens_only_its_own_executable():
    other = rule("mysqld (XAMPP)", program=r"C:\xampp\mysql\bin\mysqld.exe")
    assert fw.evaluate(sock(), state(other), {}).verdict == "blocked"
    mine = rule("MySQL 8.4", program=MYSQLD.lower())  # la casse du chemin ne compte pas
    v = fw.evaluate(sock(), state(mine), {})
    assert v.verdict == "open" and v.scope == "any" and v.rules[0]["name"] == "MySQL 8.4"


def test_rule_on_inactive_profile_is_ignored():
    v = fw.evaluate(sock(), state(rule(program=MYSQLD, profiles=PRIVATE), active=PUBLIC), {})
    assert v.verdict == "blocked"


def test_block_rule_wins_over_allow():
    v = fw.evaluate(sock(), state(rule("ok", program=MYSQLD), rule("stop", allow=False, ports="3306")), {})
    assert v.verdict == "blocked" and "stop" in v.reason


def test_port_ranges_and_protocol():
    r = rule(ports="3300-3310,8080")
    assert fw.evaluate(sock(), state(r), {}).verdict == "open"
    assert fw.evaluate(sock(port=8081), state(r), {}).verdict == "blocked"
    assert fw.evaluate(sock(proto="udp"), state(r), {}).verdict == "blocked"  # règle TCP seulement


def test_scope_local_subnet_and_interface():
    assert fw.evaluate(sock(), state(rule(ports="3306", remote="LocalSubnet")), {}).scope == "local_subnet"
    v = fw.evaluate(sock(), state(rule(ports="3306", interfaces=("vEthernet (WSL)",))), {})
    assert v.scope == "restricted" and "vEthernet (WSL)" in v.reason
    # La portée la plus large l'emporte.
    both = state(rule("lan", ports="3306", remote="LocalSubnet"), rule("tous", ports="3306"))
    assert fw.evaluate(sock(), both, {}).scope == "any"


def test_service_rule_matches_hosting_svchost_only():
    r = rule("RDP", ports="3389", service="termservice")
    rdp = sock(port=3389, exe=r"C:\Windows\System32\svchost.exe", pid=900, process="svchost.exe")
    assert fw.evaluate(rdp, state(r), {900: {"termservice"}}).verdict == "open"
    assert fw.evaluate(rdp, state(r), {900: {"dnscache"}}).verdict == "blocked"


def test_system_program_rule_targets_pid_4():
    r = rule("SMB", program="System", ports="445")
    assert fw.evaluate(sock(port=445, exe=None, pid=4, process="System"), state(r), {}).verdict == "open"
    assert fw.evaluate(sock(port=445), state(r), {}).verdict == "blocked"


def test_unreadable_path_or_ipsec_rule_is_uncertain():
    assert fw.evaluate(sock(exe=None), state(rule(program=MYSQLD)), {}).verdict == "unknown"
    assert fw.evaluate(sock(), state(rule(ports="3306", secure=True)), {}).verdict == "unknown"
    assert fw.evaluate(sock(), state(rule(ports="RPC")), {}).verdict == "blocked"  # 3306 hors RPC
    assert fw.evaluate(sock(port=49670), state(rule(ports="RPC")), {}).verdict == "unknown"


def test_packaged_app_rules_do_not_open_classic_programs():
    store = rule("Microsoft Store", protocol=256, packaged=True)
    assert fw.evaluate(sock(), state(store), {}).verdict == "blocked"


def test_profile_switches():
    off = state(enabled={1: True, 2: True, 4: False})
    assert fw.evaluate(sock(), off, {}).verdict == "open"
    shields = state(rule(program=MYSQLD), block_all={1: False, 2: False, 4: True})
    assert fw.evaluate(sock(), shields, {}).verdict == "blocked"
    permissive = state(default_block={1: True, 2: True, 4: False})
    assert fw.evaluate(sock(), permissive, {}).verdict == "open"


def test_unreadable_firewall_is_unknown_not_safe():
    assert fw.evaluate(sock(), fw.FwState(available=False), {}).verdict == "unknown"


# ─────────────────────────────── risque
def test_risk_levels():
    assert assess("tcp", 3306, "mysqld.exe", "open", "any", public=False).level == "high"
    assert assess("tcp", 3306, "mysqld.exe", "open", "any", public=True).level == "critical"  # Wi-Fi public
    assert assess("tcp", 3306, "mysqld.exe", "open", "local_subnet", public=True).level == "medium"
    assert assess("tcp", 3306, "mysqld.exe", "blocked", None, public=True).level == "info"
    assert assess("tcp", 49666, "svchost.exe", "open", "any", public=False).service == "RPC dynamique de Windows"
    unknown = assess("tcp", 41234, "truc.exe", "open", "any", public=False)
    assert unknown.level == "medium" and unknown.advice and unknown.service == "truc.exe"


# ─────────────────────────────── réel + API
@pytest.mark.skipif(sys.platform != "win32", reason="pare-feu Windows")
def test_real_firewall_read():
    pytest.importorskip("win32com.client")
    s, services = fw.read_state(force=True)
    assert s.available and s.rules and s.active in range(1, 8)
    assert services  # des services Windows tournent toujours


def test_exposure_endpoint():
    viewer = User(email="viewer@test.local", role=Role.viewer, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: viewer
    try:
        body = TestClient(app).get("/metrics/exposure").json()
    finally:
        app.dependency_overrides.clear()
    assert {"available", "profiles", "ports", "summary", "networks"} <= body.keys()
    for p in body["ports"]:
        assert p["verdict"] in ("open", "blocked", "local", "unknown")
        assert p["risk"]["level"] in ("info", "low", "medium", "high", "critical")
