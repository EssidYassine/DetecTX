"""Sonar, couche passive : adresses MAC, filtrage de la table ARP, référence et détections."""

import asyncio
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models.alert import Alert
from app.models.network import NetDevice, NetNetwork
from app.network import classify, service
from app.network.neighbors import (
    Interface,
    Neighbor,
    NeighborRow,
    Observation,
    is_randomized,
    is_unicast,
    lan_neighbors,
    normalize_mac,
)
from app.network.service import Known, assess, network_key

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
WIFI = Interface(index=21, ip="192.168.1.124", network="192.168.1.0/24", gateway="192.168.1.1")
BOX = "a2:00:00:00:00:01"  # MAC « administrée localement » : fréquent pour une box
LAPTOP = "98:59:7a:00:00:02"
ATTACKER = "3c:22:fb:00:00:01"
PHONE = "da:a1:19:00:00:02"  # MAC privée


# ─────────────────────────────── adresses MAC
@pytest.mark.parametrize(
    ("raw", "expected"),
    [("A2-00-00-00-00-01", BOX), ("a2:00:00:00:00:01", BOX), ("", None), ("00-00-00", None), ("ZZ-00-00-00-00-01", None), ("A2-00-00-00-00-01-00-00", None)],
)
def test_normalisation_mac(raw, expected):
    assert normalize_mac(raw) == expected


@pytest.mark.parametrize(("mac", "unicast"), [(BOX, True), (LAPTOP, True), ("01:00:5e:7f:ff:fa", False), ("ff:ff:ff:ff:ff:ff", False), ("00:00:00:00:00:00", False)])
def test_unicast(mac, unicast):
    assert is_unicast(mac) is unicast


def test_mac_privee():
    assert is_randomized(BOX) and is_randomized(PHONE)
    assert not is_randomized(LAPTOP)


# ─────────────────────────────── filtrage de la table ARP
def _row(ip: str, mac: str, state: int = 5, if_index: int = 21) -> NeighborRow:
    return NeighborRow(if_index=if_index, ip=ip, mac=mac, state=state)


def test_filtrage_table_arp_reelle():
    """Table réelle (adresses anonymisées) : seuls la box et un appareil du Wi-Fi sont des voisins."""
    rows = [
        _row("255.255.255.255", "FF-FF-FF-FF-FF-FF", 6),
        _row("239.255.255.250", "01-00-5E-7F-FF-FA", 6),
        _row("224.0.0.251", "01-00-5E-00-00-FB", 6),
        _row("192.168.1.255", "FF-FF-FF-FF-FF-FF", 6),
        _row("192.168.1.151", "98-59-7A-00-00-02", 4),  # périmé : vu récemment, gardé
        _row("192.168.1.1", "A2-00-00-00-00-01", 5),
        _row("172.20.10.1", "00-00-00-00-00-00", 0),  # ancien partage de connexion, injoignable
        _row("169.254.255.255", "00-00-00-00-00-00", 0),
        _row("192.168.50.7", "11-22-33-44-55-66", 5, if_index=14),  # carte virtuelle : autre réseau
        _row("192.168.1.124", "AA-AA-AA-AA-AA-AA", 6),  # le poste lui-même
        _row("192.168.1.0", "AA-AA-AA-AA-AA-AB", 5),  # adresse du réseau
    ]
    assert lan_neighbors(WIFI, rows) == (
        Neighbor(ip="192.168.1.1", mac=BOX, is_gateway=True, randomized=True),
        Neighbor(ip="192.168.1.151", mac=LAPTOP, is_gateway=False, randomized=False),
    )


@pytest.mark.parametrize("state", [0, 1])
def test_voisin_injoignable_ignore(state):
    assert lan_neighbors(WIFI, [_row("192.168.1.50", "98-59-7A-00-00-03", state)]) == ()


def test_voisin_hors_sous_reseau_ignore():
    assert lan_neighbors(WIFI, [_row("10.0.0.5", "98-59-7A-00-00-03")]) == ()


# ─────────────────────────────── classement
def test_classement():
    assert classify.kind(is_gateway=True, randomized=True) == "gateway"  # pas « téléphone »
    assert classify.kind(is_gateway=False, randomized=True) == "mobile"
    assert classify.kind(is_gateway=False, randomized=False) == "unknown"
    assert set(classify.LABEL) == set(classify.KINDS)


# ─────────────────────────────── détections (pures)
def _obs(*devices: tuple[str, str], names: tuple[str, ...] = ("Maison-5G",)) -> Observation:
    neighbors = tuple(Neighbor(ip=ip, mac=mac, is_gateway=ip == WIFI.gateway, randomized=is_randomized(mac)) for ip, mac in devices)
    return Observation(interface=WIFI, neighbors=neighbors, network_names=names)


KNOWN = Known(gateway_mac=BOX, macs=frozenset({BOX, LAPTOP}))
HOME = _obs(("192.168.1.1", BOX), ("192.168.1.151", LAPTOP))


def test_premier_passage_sans_alerte():
    assert assess(HOME, None, "k", NOW) == []


def test_reseau_inchange_sans_alerte():
    assert assess(HOME, KNOWN, "k", NOW) == []


def test_changement_ip_sans_alerte():
    moved = _obs(("192.168.1.1", BOX), ("192.168.1.77", LAPTOP))  # nouveau bail DHCP
    assert assess(moved, KNOWN, "k", NOW) == []


def test_nouvel_appareil():
    (alert,) = assess(_obs(("192.168.1.1", BOX), ("192.168.1.151", LAPTOP), ("192.168.1.42", "3c:22:fb:00:00:09")), KNOWN, "k", NOW)
    assert alert["rule_id"] == "network-new-device"
    assert alert["severity"] == "medium" and alert["mitre"] == "T1200"
    assert alert["dedup_key"] == "net-new:k:3c:22:fb:00:00:09"
    assert "192.168.1.42" in alert["message"] and "table ARP" in alert["message"]


def test_nouvel_appareil_mac_privee_faible():
    (alert,) = assess(_obs(("192.168.1.1", BOX), ("192.168.1.151", LAPTOP), ("192.168.1.43", PHONE)), KNOWN, "k", NOW)
    assert alert["severity"] == "low"
    assert "téléphone" in alert["message"]


def test_passerelle_usurpee_critique():
    """Empoisonnement ARP : l'IP de la box répond avec la MAC d'un autre appareil du réseau."""
    spoofed = _obs(("192.168.1.1", ATTACKER), ("192.168.1.151", LAPTOP), ("192.168.1.66", ATTACKER))
    alerts = {a["rule_id"]: a for a in assess(spoofed, KNOWN, "k", NOW)}
    gw = alerts["network-gateway-mac-change"]
    assert gw["severity"] == "critical" and gw["mitre"] == "T1557.002"
    assert BOX in gw["message"] and ATTACKER in gw["message"]
    assert "192.168.1.66" in gw["message"]  # l'appareil qui se fait passer pour la box est nommé
    assert gw["dedup_key"] == f"net-gw:k:{ATTACKER}"
    # l'IP de l'attaquant est aussi signalée comme nouvel appareil ; la passerelle, une seule fois
    assert alerts["network-new-device"]["dedup_key"] == f"net-new:k:{ATTACKER}"
    assert len(alerts) == 2


def test_passerelle_changee_reseau_non_identifie_elevee():
    alerts = assess(_obs(("192.168.1.1", ATTACKER), ("192.168.1.151", LAPTOP), names=()), KNOWN, "k", NOW)
    (gw,) = [a for a in alerts if a["rule_id"] == "network-gateway-mac-change"]
    assert gw["severity"] == "high"
    assert "Nom du réseau inconnu" in gw["message"]


def test_passerelle_sans_reference_adoptee_sans_alerte():
    assert assess(HOME, Known(gateway_mac=None, macs=frozenset({BOX, LAPTOP})), "k", NOW) == []


def test_meme_passerelle_autre_reseau_autre_cle():
    """Maison et café en 192.168.1.1 : deux références distinctes, pas de fausse usurpation."""
    assert network_key(_obs(("192.168.1.1", BOX), names=("Maison-5G",))) != network_key(_obs(("192.168.1.1", BOX), names=("Cafe-WiFi",)))
    assert network_key(HOME) == network_key(_obs(("192.168.1.1", BOX), names=("Maison-5G",)))


# ─────────────────────────────── réconciliation (base en mémoire)
def _with_db(monkeypatch, scenario):
    async def main():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        maker = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(service, "SessionLocal", maker)
        monkeypatch.setattr(service.notify, "enabled", lambda: False)
        try:
            return await scenario(maker)
        finally:
            await engine.dispose()

    return asyncio.run(main())


def test_reconciliation_reference_puis_detection(monkeypatch):
    async def scenario(maker):
        first = await service.reconcile(HOME, now=NOW)
        spoofed = _obs(("192.168.1.1", ATTACKER), ("192.168.1.151", LAPTOP), ("192.168.1.66", ATTACKER))
        second = await service.reconcile(spoofed, now=NOW + timedelta(minutes=1))
        third = await service.reconcile(spoofed, now=NOW + timedelta(minutes=2))  # même situation : dédupliquée
        async with maker() as session:
            alerts = (await session.scalars(select(Alert))).all()
            devices = {d.mac: d for d in (await session.scalars(select(NetDevice))).all()}
            (net,) = (await session.scalars(select(NetNetwork))).all()
        return first, second, third, alerts, devices, net

    first, second, third, alerts, devices, net = _with_db(monkeypatch, scenario)
    assert first == [] and third == []
    assert {a["rule_id"] for a in second} == {"network-gateway-mac-change", "network-new-device"}
    assert len(alerts) == 2
    assert net.gateway_mac == BOX and net.name == "Maison-5G"  # la référence ne bouge pas seule
    assert devices[BOX].status == "baseline" and devices[LAPTOP].status == "baseline"
    assert devices[ATTACKER].status == "new"
    # « répond pour la passerelle » suit l'observation ; « est la box » suit la référence
    assert devices[ATTACKER].is_gateway and not devices[BOX].is_gateway
    assert devices[BOX].kind == "gateway"  # la vraie box reste la box (sa MAC privée n'en fait pas un téléphone)
    assert devices[ATTACKER].kind == "unknown"


def test_reconciliation_passerelle_adoptee_plus_tard(monkeypatch):
    """Box absente de la table ARP au premier passage : adoptée comme référence à sa 1re apparition."""

    async def scenario(maker):
        await service.reconcile(_obs(("192.168.1.151", LAPTOP)), now=NOW)
        created = await service.reconcile(HOME, now=NOW + timedelta(minutes=1))
        async with maker() as session:
            (net,) = (await session.scalars(select(NetNetwork))).all()
            box = await session.get(NetDevice, f"{net.key}:{BOX}")
        return created, net, box

    created, net, box = _with_db(monkeypatch, scenario)
    assert net.gateway_mac == BOX and box.kind == "gateway"
    assert created == []  # pas « nouvel appareil » : la passerelle est contrôlée par sa MAC de référence


def test_reconciliation_retour_apres_absence(monkeypatch):
    async def scenario(_maker):
        await service.reconcile(HOME, now=NOW)
        await service.reconcile(_obs(("192.168.1.1", BOX)), now=NOW + timedelta(hours=1))  # le portable est éteint
        return await service.reconcile(HOME, now=NOW + timedelta(hours=2))  # il revient

    assert _with_db(monkeypatch, scenario) == []


def test_apprentissage_absorbe_le_foyer_mais_surveille_la_box(monkeypatch):
    """Pendant l'apprentissage, le foyer qui apparaît peu à peu rejoint la référence ; la box est contrôlée."""
    monkeypatch.setattr(service.settings, "network_learning_hours", 24)
    phone = ("192.168.1.43", PHONE)
    intruder = ("192.168.1.66", "3c:22:fb:00:00:09")

    async def scenario(maker):
        await service.reconcile(HOME, now=NOW)
        learning = await service.reconcile(_obs(("192.168.1.1", BOX), ("192.168.1.151", LAPTOP), phone), now=NOW + timedelta(hours=3))
        spoof = await service.reconcile(_obs(("192.168.1.1", ATTACKER), ("192.168.1.151", LAPTOP)), now=NOW + timedelta(hours=4))
        after = await service.reconcile(_obs(("192.168.1.1", BOX), ("192.168.1.151", LAPTOP), intruder), now=NOW + timedelta(hours=25))
        async with maker() as session:
            status = {d.mac: d.status for d in (await session.scalars(select(NetDevice))).all()}
        return learning, spoof, after, status

    learning, spoof, after, status = _with_db(monkeypatch, scenario)
    assert learning == [] and status[PHONE] == "baseline"
    assert [a["rule_id"] for a in spoof] == ["network-gateway-mac-change"]  # dès l'apprentissage
    assert [a["rule_id"] for a in after] == ["network-new-device"]  # fin de l'apprentissage
    assert status["3c:22:fb:00:00:09"] == "new"
