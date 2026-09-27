"""Actions pare-feu (phase B) : validation, garde-fous, vérification, droits, audit.

Aucun test ne modifie le pare-feu du poste : l'élévation UAC et la relecture des règles sont
simulées. L'assistant n'est exécuté pour de vrai que sans droits admin, où il doit refuser
AVANT de toucher au pare-feu.
"""

import threading

import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.main import app
from app.models.user import Role, User
from app.services import firewall_actions as actions
from app.services import fw_helper as helper


# ─────────────────────────────── assistant : validation (défense en profondeur)
def test_helper_parsing_and_names():
    assert helper.parse_targets("tcp:445, udp:137,tcp:445") == [("tcp", 445), ("udp", 137)]  # dédoublonné
    assert helper.parse_profiles("public,private") == ["private", "public"]  # ordre canonique
    for bad in ("tcp:0", "tcp:70000", "tcp:445;calc", "icmp:1", "445", "", ",".join(f"tcp:{p}" for p in range(1, 23))):
        with pytest.raises(helper.Refused):
            helper.parse_targets(bad)
    with pytest.raises(helper.Refused):
        helper.parse_profiles("all")
    name = helper.rule_name("tcp", 445, ["private", "public"])
    assert name == "DeTecTX - bloque TCP 445 (private+public)" and helper.NAME_RE.match(name)


@pytest.mark.parametrize(
    "name",
    ["Microsoft Store", "DeTecTX - bloque TCP 445 (public)\" & calc", "DeTecTX - bloque TCP 445 (public) ", "detectx - bloque TCP 445 (public)"],
)
def test_helper_refuses_foreign_or_malformed_names(name):
    assert helper.main(["unblock", "--name", name]) == helper.EXIT_ARGS


@pytest.mark.skipif(helper.is_admin(), reason="exécuté élevé : le test modifierait le pare-feu")
def test_helper_refuses_without_admin_before_touching_firewall():
    assert helper.main(["block", "--targets", "tcp:5999", "--profiles", "public"]) == helper.EXIT_NOT_ADMIN


# ─────────────────────────────── actions : élévation simulée
@pytest.fixture
def fake_firewall(monkeypatch):
    """Pare-feu simulé : l'assistant « élevé » applique ses règles dans un ensemble."""
    rules: set[str] = set()
    calls: list[list[str]] = []

    def run(args):
        calls.append(args)
        if args[0] == "block":
            targets = helper.parse_targets(args[args.index("--targets") + 1])
            profiles = helper.parse_profiles(args[args.index("--profiles") + 1])
            rules.update(helper.rule_name(proto, port, profiles) for proto, port in targets)
        else:
            rules.discard(args[args.index("--name") + 1])
        return helper.EXIT_OK

    monkeypatch.setattr(actions, "_run_elevated", run)
    monkeypatch.setattr(actions, "_detectx_rule_names", lambda: set(rules))
    return rules, calls


def test_block_then_unblock_is_verified(fake_firewall):
    rules, calls = fake_firewall
    result = actions.block([("tcp", 445), ("udp", 137)], ["public"])
    assert result["rules"] == ["DeTecTX - bloque TCP 445 (public)", "DeTecTX - bloque UDP 137 (public)"]
    assert calls == [["block", "--targets", "tcp:445,udp:137", "--profiles", "public"]]  # une seule élévation
    actions.unblock("DeTecTX - bloque TCP 445 (public)")
    assert rules == {"DeTecTX - bloque UDP 137 (public)"}


def test_success_code_without_the_rule_is_an_error(monkeypatch):
    monkeypatch.setattr(actions, "_run_elevated", lambda args: helper.EXIT_OK)
    monkeypatch.setattr(actions, "_detectx_rule_names", lambda: set())  # rien n'a été créé
    with pytest.raises(actions.ActionError) as exc:
        actions.block([("tcp", 445)], ["public"])
    assert exc.value.status == 502


@pytest.mark.parametrize(
    ("code", "status"),
    [(helper.EXIT_ARGS, 400), (helper.EXIT_FIREWALL, 502), (helper.EXIT_NOT_ADMIN, 403), (99, 500)],
)
def test_helper_exit_codes_map_to_http(monkeypatch, code, status):
    monkeypatch.setattr(actions, "_run_elevated", lambda args: code)
    with pytest.raises(actions.ActionError) as exc:
        actions.block([("tcp", 445)], ["public"])
    assert exc.value.status == status


def test_uac_refusal_propagates(monkeypatch):
    def refused(args):
        raise actions.ActionError(403, "Autorisation refusée dans l'invite Windows : aucune règle modifiée.")

    monkeypatch.setattr(actions, "_run_elevated", refused)
    with pytest.raises(actions.ActionError) as exc:
        actions.unblock("DeTecTX - bloque TCP 445 (public)")
    assert exc.value.status == 403


def test_one_action_at_a_time(fake_firewall):
    held = threading.Event()
    with actions._lock:
        held.set()
        with pytest.raises(actions.ActionError) as exc:
            actions.block([("tcp", 445)], ["public"])
    assert exc.value.status == 409


def test_invalid_requests_never_reach_elevation(monkeypatch):
    monkeypatch.setattr(actions, "_run_elevated", lambda args: pytest.fail("élévation demandée pour une requête invalide"))
    for call in (lambda: actions.block([("icmp", 1)], ["public"]), lambda: actions.block([("tcp", 0)], ["public"]), lambda: actions.unblock("Microsoft Store")):
        with pytest.raises(actions.ActionError) as exc:
            call()
        assert exc.value.status == 400


# ─────────────────────────────── API : droits, validation, audit
def _client(role: Role) -> TestClient:
    user = User(email=f"{role.value}@test.local", role=role, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def test_only_admins_can_touch_the_firewall(fake_firewall):
    body = {"targets": [{"proto": "tcp", "port": 445}], "profiles": ["public"]}
    for role in (Role.analyst, Role.viewer):
        assert _client(role).post("/metrics/firewall/block", json=body).status_code == 403
        assert _client(role).post("/metrics/firewall/unblock", json={"name": "DeTecTX - bloque TCP 445 (public)"}).status_code == 403
    assert fake_firewall[1] == []  # aucune élévation demandée


@pytest.mark.parametrize(
    "body",
    [
        {"targets": [{"proto": "tcp", "port": 0}], "profiles": ["public"]},
        {"targets": [{"proto": "tcp", "port": 445}], "profiles": ["all"]},
        {"targets": [{"proto": "icmp", "port": 445}], "profiles": ["public"]},
        {"targets": [], "profiles": ["public"]},
        {"targets": [{"proto": "tcp", "port": p} for p in range(1, 22)], "profiles": ["public"]},
    ],
)
def test_block_validation(fake_firewall, body):
    assert _client(Role.admin).post("/metrics/firewall/block", json=body).status_code == 422


def test_admin_block_is_audited(fake_firewall, caplog):
    with caplog.at_level("INFO", logger="detectx.audit"):
        res = _client(Role.admin).post("/metrics/firewall/block", json={"targets": [{"proto": "tcp", "port": 445}], "profiles": ["public"]})
    assert res.status_code == 200 and res.json()["rules"] == ["DeTecTX - bloque TCP 445 (public)"]
    line = next(r.getMessage() for r in caplog.records if r.name == "detectx.audit")
    assert "firewall_block" in line and "actor=admin@test.local" in line
    assert _client(Role.admin).post("/metrics/firewall/unblock", json={"name": "Microsoft Store"}).status_code == 422


def test_exposure_lists_detectx_rules():
    body = _client(Role.viewer).get("/metrics/exposure").json()
    assert "detectx_rules" in body and "elevated" in body
