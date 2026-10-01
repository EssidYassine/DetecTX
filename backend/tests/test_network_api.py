"""Sonar, API /network : droits, validation, réseau courant, scans à la demande, box et référence."""

import asyncio
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from app.db import Base
from app.deps import get_current_user
from app.main import app
from app.models.network import NetDevice, NetNetwork, NetScan
from app.models.user import Role, User
from app.network import active, inventory, service, sonar
from app.network.neighbors import Interface, Neighbor, Observation
from app.network.nmap_runner import Host
from app.routers import network as router

WIFI = Interface(index=21, ip="192.168.1.124", network="192.168.1.0/24", gateway="192.168.1.1")
BOX = "a2:00:00:00:00:01"
PC = "98:59:7a:00:00:02"
ATTACKER = "3c:22:fb:00:00:66"
NMAP = Path("C:/Program Files (x86)/Nmap/nmap.exe")


def _obs(*devices, names=("Maison-5G",), categories=("private",)) -> Observation:
    neighbors = tuple(Neighbor(ip=ip, mac=mac, is_gateway=ip == WIFI.gateway, randomized=bool(int(mac[:2], 16) & 2)) for ip, mac in devices)
    return Observation(interface=WIFI, neighbors=neighbors, network_names=names, categories=categories)


HOME = _obs(("192.168.1.1", BOX), ("192.168.1.151", PC))
KEY = service.network_key(HOME)
PC_ID = f"{KEY}:{PC}"
BOX_ID = f"{KEY}:{BOX}"


@pytest.fixture
def db(tmp_path, monkeypatch):
    engine = create_async_engine(f"sqlite+aiosqlite:///{tmp_path / 'net.db'}", poolclass=NullPool)

    async def create():
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.run(create())
    maker = async_sessionmaker(engine, expire_on_commit=False)
    for module in (service, active, inventory):
        monkeypatch.setattr(module, "SessionLocal", maker)
    monkeypatch.setattr(service.notify, "enabled", lambda: False)
    asyncio.run(service.reconcile(HOME))
    yield maker
    asyncio.run(engine.dispose())


@pytest.fixture
def current(monkeypatch):
    """Réseau courant renvoyé par la lecture de la table ARP (modifiable par le test)."""
    state = {"obs": HOME}

    async def fake():
        return state["obs"]

    monkeypatch.setattr(sonar, "current", fake)
    monkeypatch.setattr(sonar.nmap_runner, "find_nmap", lambda _path="": NMAP)
    monkeypatch.setattr(sonar.settings, "network_active_scan", True)
    return state


@pytest.fixture(autouse=True)
def _clean():
    router._scan_calls.clear()
    sonar._state["running"] = None
    yield
    app.dependency_overrides.clear()
    sonar._state["running"] = None


def _client(role: Role) -> TestClient:
    user = User(email=f"{role.value}@test.local", role=role, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def _rows(maker, model):
    async def read():
        async with maker() as session:
            return (await session.scalars(select(model))).all()

    return asyncio.run(read())


# ─────────────────────────────── droits
def test_lecteur_lit_mais_n_agit_pas(db, current):
    viewer = _client(Role.viewer)
    assert viewer.get("/network/status").status_code == 200
    assert viewer.get("/network/devices").status_code == 200
    assert viewer.get(f"/network/devices/{PC_ID}").status_code == 200
    assert viewer.get("/network/scans").status_code == 200
    assert viewer.patch(f"/network/devices/{PC_ID}", json={"approve": True}).status_code == 403
    assert viewer.post("/network/scan", json={"profile": "discovery"}).status_code == 403
    assert viewer.post("/network/gateway/accept", json={"device_id": BOX_ID}).status_code == 403
    assert viewer.post("/network/baseline").status_code == 403


def test_analyste_ne_touche_ni_a_la_box_ni_a_la_reference(db, current):
    analyst = _client(Role.analyst)
    assert analyst.post("/network/gateway/accept", json={"device_id": BOX_ID}).status_code == 403
    assert analyst.post("/network/baseline").status_code == 403


def test_sans_connexion_refuse(db, current):
    assert TestClient(app).get("/network/devices").status_code == 401


# ─────────────────────────────── lecture
def test_inventaire(db, current):
    body = _client(Role.viewer).get("/network/devices").json()
    assert body["network"]["name"] == "Maison-5G" and body["network"]["gateway_mac"] == BOX
    box, pc = body["devices"]  # la box d'abord
    assert box["is_gateway"] and box["kind_label"] == "Box / routeur" and not box["gateway_mismatch"]
    assert pc["mac"] == PC and pc["risk"] == "info" and pc["ports"] == []


def test_statut(db, current):
    current["obs"] = _obs(("192.168.1.1", BOX), categories=("public",))
    body = _client(Role.viewer).get("/network/status").json()
    assert body["online"] and body["nmap_installed"] and "Privé" in body["active_blocked"]
    assert body["network"]["subnet"] == "192.168.1.0/24" and body["scans"] == []


def test_hors_ligne(db, current):
    current["obs"] = None
    client = _client(Role.viewer)
    assert client.get("/network/devices").status_code == 503
    assert client.get("/network/status").json()["online"] is False


def test_appareil_d_un_autre_reseau_invisible(db, current):
    cafe = _obs(("192.168.1.1", "a2:00:00:00:00:99"), ("192.168.1.30", "98:59:7a:00:00:30"), names=("Cafe-WiFi",))
    asyncio.run(service.reconcile(cafe))
    other = f"{service.network_key(cafe)}:98:59:7a:00:00:30"
    client = _client(Role.analyst)
    assert client.get(f"/network/devices/{other}").status_code == 404  # on est à la maison
    assert client.patch(f"/network/devices/{other}", json={"approve": True}).status_code == 404


# ─────────────────────────────── renommer / approuver
def test_renommer_et_approuver(db, current):
    res = _client(Role.analyst).patch(f"/network/devices/{PC_ID}", json={"label": "  PC du salon ", "approve": True})
    assert res.status_code == 200
    assert res.json()["label"] == "PC du salon" and res.json()["status"] == "approved"
    res = _client(Role.analyst).patch(f"/network/devices/{PC_ID}", json={"label": None})
    assert res.json()["label"] is None and res.json()["status"] == "approved"  # le nom seul est effacé


@pytest.mark.parametrize(
    "body",
    [{}, {"label": "a" * 81}, {"label": "PC\x00"}, {"label": "PC\nadmin"}, {"approve": "yes"}, {"approve": 1}],
)
def test_modification_invalide(db, current, body):
    assert _client(Role.analyst).patch(f"/network/devices/{PC_ID}", json=body).status_code == 422


@pytest.mark.parametrize("device_id", ["192.168.1.151", "x" * 32 + ":98:59:7a:00:00:02", f"{KEY}:98-59-7A-00-00-02", "../../etc"])
def test_identifiant_mal_forme(db, current, device_id):
    assert _client(Role.analyst).get(f"/network/devices/{device_id}").status_code in (404, 422)


def test_appareil_inconnu(db, current):
    assert _client(Role.analyst).patch(f"/network/devices/{KEY}:98:59:7a:00:00:77", json={"approve": True}).status_code == 404


# ─────────────────────────────── scans à la demande
def test_scan_refuse_sur_reseau_public(db, current):
    current["obs"] = _obs(("192.168.1.1", BOX), categories=("public",))
    res = _client(Role.analyst).post("/network/scan", json={"profile": "discovery"})
    assert res.status_code == 409 and "Privé" in res.json()["detail"]


def test_scan_refuse_sans_nmap(db, current, monkeypatch):
    monkeypatch.setattr(sonar.nmap_runner, "find_nmap", lambda _path="": None)
    res = _client(Role.analyst).post("/network/scan", json={"profile": "discovery"})
    assert res.status_code == 409 and "nmap.org" in res.json()["detail"]


@pytest.mark.parametrize(
    "body",
    [
        {"profile": "deep"},  # sans appareil
        {"profile": "discovery", "device_id": PC_ID},  # appareil hors profil
        {"profile": "nse"},
        {"profile": "deep", "device_id": "192.168.1.151"},  # jamais une IP libre
    ],
)
def test_scan_requete_invalide(db, current, body):
    assert _client(Role.analyst).post("/network/scan", json=body).status_code == 422


def test_scan_champ_inconnu_n_atteint_pas_nmap(db, current, monkeypatch):
    seen = {}

    async def fake_launch(obs, profile, actor, device_ip=None):
        seen.update(profile=profile, device_ip=device_ip)
        return {"profile": profile, "target": obs.interface.network, "actor": actor, "started_at": None}

    monkeypatch.setattr(sonar, "launch", fake_launch)
    res = _client(Role.analyst).post("/network/scan", json={"profile": "discovery", "args": "--script vuln"})
    assert res.status_code == 202 and seen == {"profile": "discovery", "device_ip": None}


def test_scan_appareil_cible_issue_de_l_inventaire(db, current, monkeypatch):
    seen = {}

    async def fake_launch(obs, profile, actor, device_ip=None):
        seen.update(profile=profile, actor=actor, device_ip=device_ip)
        return {"profile": profile, "target": device_ip, "actor": actor, "started_at": None}

    monkeypatch.setattr(sonar, "launch", fake_launch)
    client = _client(Role.analyst)
    assert client.post("/network/scan", json={"profile": "deep", "device_id": PC_ID}).status_code == 202
    assert seen == {"profile": "deep", "actor": "analyst@test.local", "device_ip": "192.168.1.151"}
    assert client.post("/network/scan", json={"profile": "deep", "device_id": f"{KEY}:98:59:7a:00:00:77"}).status_code == 404


def test_scan_limite_de_frequence(db, current, monkeypatch):
    async def fake_launch(obs, profile, actor, device_ip=None):
        return {"profile": profile, "target": obs.interface.network, "actor": actor, "started_at": None}

    monkeypatch.setattr(sonar, "launch", fake_launch)
    client = _client(Role.analyst)
    assert [client.post("/network/scan", json={"profile": "discovery"}).status_code for _ in range(3)] == [202, 202, 429]


def test_scan_refuse_ne_compte_pas_dans_la_limite(db, current):
    current["obs"] = _obs(("192.168.1.1", BOX), categories=("public",))
    client = _client(Role.analyst)
    assert [client.post("/network/scan", json={"profile": "discovery"}).status_code for _ in range(3)] == [409, 409, 409]


def test_un_seul_scan_a_la_fois(db, current):
    sonar._state["running"] = {"profile": "deep", "target": "192.168.1.151", "actor": "x", "started_at": None}
    res = _client(Role.analyst).post("/network/scan", json={"profile": "discovery"})
    assert res.status_code == 409 and "déjà en cours" in res.json()["detail"]


def test_lancement_en_tache_de_fond(db, monkeypatch):
    """launch() rend la main tout de suite ; le scan tourne, est tracé, puis libère l'état."""
    monkeypatch.setattr(sonar.nmap_runner, "find_nmap", lambda _path="": NMAP)
    monkeypatch.setattr(sonar.settings, "network_active_scan", True)
    monkeypatch.setattr(active.nmap_runner, "run", lambda argv, timeout: [Host("192.168.1.1", BOX), Host("192.168.1.151", PC)])
    monkeypatch.setattr(active.neighbors, "observe", lambda: HOME)

    async def scenario():
        running = await sonar.launch(HOME, "discovery", "analyst@test.local")
        assert sonar._state["running"]["actor"] == "analyst@test.local"
        await asyncio.gather(*sonar._tasks)
        return running

    running = asyncio.run(scenario())
    assert running["profile"] == "discovery" and running["target"] == "192.168.1.0/24"
    assert sonar._state["running"] is None and sonar._state["error"] is None
    assert [s.actor for s in _rows(db, NetScan)] == ["analyst@test.local"]



# ─────────────────────────────── box et référence
def _spoof(db):
    asyncio.run(service.reconcile(_obs(("192.168.1.1", ATTACKER), ("192.168.1.151", PC))))


def test_accepter_une_nouvelle_box(db, current):
    _spoof(db)
    current["obs"] = _obs(("192.168.1.1", ATTACKER), ("192.168.1.151", PC))
    new_id = f"{KEY}:{ATTACKER}"
    listing = _client(Role.viewer).get("/network/devices").json()["devices"]
    assert listing[0]["id"] == new_id and listing[0]["gateway_mismatch"]  # l'usurpation en tête de liste
    admin = _client(Role.admin)
    assert admin.post("/network/gateway/accept", json={"device_id": PC_ID}).status_code == 409  # ne répond pas pour la box
    res = admin.post("/network/gateway/accept", json={"device_id": new_id})
    assert res.status_code == 200 and res.json()["is_gateway"] and res.json()["kind"] == "gateway"
    (net,) = _rows(db, NetNetwork)
    assert net.gateway_mac == ATTACKER
    assert admin.post("/network/gateway/accept", json={"device_id": new_id}).status_code == 409  # déjà la référence
    old_box = next(d for d in _rows(db, NetDevice) if d.mac == BOX)
    assert old_box.kind != "gateway"


def test_nouvelle_reference(db, current):
    asyncio.run(service.reconcile(_obs(("192.168.1.1", BOX), ("192.168.1.151", PC), ("192.168.1.66", ATTACKER))))
    assert {d.status for d in _rows(db, NetDevice)} == {"baseline", "new"}
    res = _client(Role.admin).post("/network/baseline")
    assert res.status_code == 200
    assert {d["status"] for d in res.json()["devices"]} == {"baseline"}  # réappris à partir de l'observation courante
