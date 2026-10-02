"""Catégorie du réseau (Public <-> Privé) : assistant élevé, service, route admin. Sans Windows."""

import pytest
from fastapi.testclient import TestClient

from app.deps import get_current_user
from app.main import app
from app.models.user import Role, User
from app.network import sonar
from app.network.neighbors import Interface, Observation
from app.services import elevation, network_profile
from app.services import netprofile_helper as helper
from app.services.elevation import ActionError


class FakeNetwork:
    def __init__(self, name: str, category: int):
        self.name, self.category, self.set_calls = name, category, []

    def GetName(self):  # interface COM (noms imposés par Windows)
        return self.name

    def GetCategory(self):
        return self.category

    def SetCategory(self, value):
        self.set_calls.append(value)
        self.category = value


# ─────────────────────────────── assistant élevé
@pytest.mark.parametrize("name", ["", "a" * 256, "Maison\x00", "Maison\n", 'Mai"son'])
def test_assistant_nom_refuse(name):
    with pytest.raises(helper.Refused):
        helper.check_name(name)


@pytest.mark.parametrize("category", ["domain", "Private", "1", ""])
def test_assistant_categorie_refusee(category):
    with pytest.raises(helper.Refused):
        helper.check_category(category)


def test_assistant_change_le_bon_reseau():
    home, other = FakeNetwork("Maison-5G", 0), FakeNetwork("Bureau", 0)
    helper.apply("Maison-5G", helper.CATEGORIES["private"], [other, home])
    assert home.set_calls == [1] and other.set_calls == []


def test_assistant_idempotent():
    home = FakeNetwork("Maison-5G", 1)
    helper.apply("Maison-5G", 1, [home])
    assert home.set_calls == []


def test_assistant_introuvable_ou_ambigu():
    with pytest.raises(helper.NotFound):
        helper.apply("Maison-5G", 1, [FakeNetwork("Cafe", 0)])
    with pytest.raises(helper.NotFound):
        helper.apply("Livebox", 1, [FakeNetwork("Livebox", 0), FakeNetwork("Livebox", 0)])


def test_assistant_ne_touche_jamais_un_reseau_de_domaine():
    corp = FakeNetwork("corp.example", helper.DOMAIN)
    with pytest.raises(helper.Refused):
        helper.apply("corp.example", 0, [corp])
    assert corp.set_calls == []


@pytest.mark.parametrize(
    "argv",
    [[], ["set"], ["set", "--name", "Maison"], ["set", "--name", "Maison", "--category", "domain"], ["delete", "--name", "x"]],
)
def test_assistant_arguments_refuses(argv):
    assert helper.main(argv) == helper.EXIT_ARGS


def test_assistant_sans_droits(monkeypatch):
    monkeypatch.setattr(helper, "is_admin", lambda: False)
    assert helper.main(["set", "--name", "Maison", "--category", "private"]) == helper.EXIT_NOT_ADMIN


# ─────────────────────────────── service
@pytest.fixture
def windows(monkeypatch):
    """Catégories vues par Windows (relecture) et lancements de l'assistant."""
    state = {"networks": [{"name": "Maison-5G", "category": "public"}], "calls": [], "apply": True}

    def run(path, args, nothing_changed, timeout=120):
        state["calls"].append(args)
        if state["apply"]:
            state["networks"] = [{"name": "Maison-5G", "category": args[-1]}]
        return helper.EXIT_OK

    monkeypatch.setattr(network_profile.firewall, "connected_networks", lambda: state["networks"])
    monkeypatch.setattr(elevation, "run_elevated", run)
    return state


def test_service_passe_en_prive_et_verifie(windows):
    assert network_profile.set_category("Maison-5G", "private") == {"ok": True, "already": False, "name": "Maison-5G", "category": "private"}
    assert windows["calls"] == [["set", "--name", "Maison-5G", "--category", "private"]]


def test_service_deja_dans_la_categorie(windows):
    assert network_profile.set_category("Maison-5G", "public")["already"] is True
    assert windows["calls"] == []  # aucune invite UAC inutile


def test_service_resultat_relu_pas_cru_sur_parole(windows):
    windows["apply"] = False  # l'assistant dit « OK » mais rien n'a changé
    with pytest.raises(ActionError) as e:
        network_profile.set_category("Maison-5G", "private")
    assert e.value.status == 502


def test_service_invite_uac_refusee(windows, monkeypatch):
    def refused(*_a, **_k):
        raise ActionError(403, "Autorisation refusée dans l'invite Windows : catégorie inchangée.")

    monkeypatch.setattr(elevation, "run_elevated", refused)
    with pytest.raises(ActionError) as e:
        network_profile.set_category("Maison-5G", "private")
    assert e.value.status == 403


@pytest.mark.parametrize(("networks", "status"), [([], 409), ([{"name": "Maison-5G", "category": "domain"}], 400)])
def test_service_reseau_introuvable_ou_de_domaine(windows, networks, status):
    windows["networks"] = networks
    with pytest.raises(ActionError) as e:
        network_profile.set_category("Maison-5G", "private")
    assert e.value.status == status and windows["calls"] == []


@pytest.mark.parametrize(("code", "status"), [(helper.EXIT_ARGS, 400), (helper.EXIT_NOT_FOUND, 409), (helper.EXIT_NOT_ADMIN, 403), (helper.EXIT_WINDOWS, 502)])
def test_service_codes_de_sortie(windows, monkeypatch, code, status):
    monkeypatch.setattr(elevation, "run_elevated", lambda *a, **k: code)
    with pytest.raises(ActionError) as e:
        network_profile.set_category("Maison-5G", "private")
    assert e.value.status == status


def test_service_une_action_a_la_fois(windows):
    assert network_profile._lock.acquire(blocking=False)
    try:
        with pytest.raises(ActionError) as e:
            network_profile.set_category("Maison-5G", "private")
        assert e.value.status == 409
    finally:
        network_profile._lock.release()


# ─────────────────────────────── route
WIFI = Interface(index=21, ip="192.168.1.124", network="192.168.1.0/24", gateway="192.168.1.1")


@pytest.fixture
def route(monkeypatch):
    state = {"obs": Observation(interface=WIFI, neighbors=(), network_names=("Maison-5G",), categories=("public",)), "calls": []}

    async def current():
        return state["obs"]

    def fake_set(name, category):
        state["calls"].append((name, category))
        return {"ok": True, "already": False, "name": name, "category": category}

    monkeypatch.setattr(sonar, "current", current)
    monkeypatch.setattr(network_profile, "set_category", fake_set)
    yield state
    app.dependency_overrides.clear()


def _client(role: Role) -> TestClient:
    user = User(email=f"{role.value}@test.local", role=role, hashed_password="x")
    app.dependency_overrides[get_current_user] = lambda: user
    return TestClient(app)


def test_route_reservee_a_l_admin(route):
    for role in (Role.analyst, Role.viewer):
        assert _client(role).post("/network/category", json={"category": "private"}).status_code == 403
    assert route["calls"] == []


@pytest.mark.parametrize("body", [{"category": "domain"}, {"category": "PRIVATE"}, {}, {"category": "private", "name": "Bureau"}])
def test_route_validation(route, body):
    res = _client(Role.admin).post("/network/category", json=body)
    if body == {"category": "private", "name": "Bureau"}:  # champ inconnu ignoré : le nom vient TOUJOURS du réseau connecté
        assert res.status_code == 200 and route["calls"] == [("Maison-5G", "private")]
    else:
        assert res.status_code == 422


def test_route_reseau_non_identifie(route):
    route["obs"] = Observation(interface=WIFI, neighbors=(), network_names=("A", "B"), categories=("public",))
    assert _client(Role.admin).post("/network/category", json={"category": "private"}).status_code == 409
    assert route["calls"] == []


def test_route_passe_en_prive(route):
    res = _client(Role.admin).post("/network/category", json={"category": "private"})
    assert res.status_code == 200 and res.json()["category"] == "private"
    assert route["calls"] == [("Maison-5G", "private")]


def test_route_refus_propage(route, monkeypatch):
    def refused(name, category):
        raise ActionError(403, "Autorisation refusée dans l'invite Windows : catégorie inchangée.")

    monkeypatch.setattr(network_profile, "set_category", refused)
    res = _client(Role.admin).post("/network/category", json={"category": "private"})
    assert res.status_code == 403 and "invite Windows" in res.json()["detail"]
