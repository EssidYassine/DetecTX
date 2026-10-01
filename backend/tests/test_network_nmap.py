"""Sonar, couche active : cibles et arguments Nmap, lecture du XML, classement, ports, réconciliation.

Fixtures XML synthétiques (structure de Nmap 7.99) : aucune vraie MAC ni vrai nom d'appareil.
"""

import asyncio
from datetime import datetime, timedelta, timezone
from ipaddress import IPv4Address, IPv4Network
from pathlib import Path

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.db import Base
from app.models.alert import Alert
from app.models.network import NetDevice, NetNetwork, NetPort, NetScan
from app.network import active, classify, nmap_runner, oui, service
from app.network.active import assess_ports, block_reason, merge
from app.network.neighbors import Interface, Neighbor, Observation
from app.network.nmap_runner import Host, Port, RawUnavailable, ScanError, parse
from app.network.target import (
    PROFILES,
    TargetRefused,
    build_argv,
    scan_host,
    scan_subnet,
)

NOW = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
LAN = IPv4Network("192.168.1.0/24")
WIFI = Interface(index=21, ip="192.168.1.124", network="192.168.1.0/24", gateway="192.168.1.1")
BOX = "a2:00:00:00:00:01"
PC = "98:59:7a:00:00:02"  # préfixe Intel
NMAP = "C:/Program Files (x86)/Nmap/nmap.exe"


# ─────────────────────────────── cibles
@pytest.mark.parametrize("net", ["192.168.1.0/24", "10.0.0.0/22", "172.20.10.0/28", "192.168.1.77/24"])
def test_sous_reseau_accepte(net):
    assert isinstance(scan_subnet(net), IPv4Network)


@pytest.mark.parametrize(
    "net",
    [
        "8.8.8.0/24",  # Internet
        "100.64.0.0/24",  # CGNAT de l'opérateur, pas le réseau de l'utilisateur
        "10.0.0.0/16",  # trop grand
        "0.0.0.0/0",
        "127.0.0.0/24",
        "169.254.0.0/24",
        "192.168.1.0/31",
        "fd00::/64",
        "",
        "192.168.1.0/24 -oN x",
        "192.168.1.0/24;calc",
    ],
)
def test_sous_reseau_refuse(net):
    with pytest.raises(TargetRefused):
        scan_subnet(net)


def test_hote_accepte():
    assert scan_host("192.168.1.42", LAN) == IPv4Address("192.168.1.42")


@pytest.mark.parametrize("ip", ["192.168.2.1", "192.168.1.0", "192.168.1.255", "8.8.8.8", "192.168.1.1;calc", "--script=vuln", "192.168.1.1 -iL x", "::1"])
def test_hote_refuse(ip):
    with pytest.raises(TargetRefused):
        scan_host(ip, LAN)


# ─────────────────────────────── arguments
def test_argv_decouverte_exact():
    assert build_argv(NMAP, "discovery", LAN) == [NMAP, "-sn", "-T4", "--max-retries", "1", "--host-timeout", "20s", "--noninteractive", "-oX", "-", "192.168.1.0/24"]


def test_argv_hote_unique():
    argv = build_argv(NMAP, "deep", IPv4Address("192.168.1.42"))
    assert argv[-1] == "192.168.1.42" and "-sV" in argv and "-O" in argv


@pytest.mark.parametrize(("profile", "tgt"), [("discovery", IPv4Address("192.168.1.42")), ("deep", LAN), ("nse", LAN)])
def test_argv_refuse(profile, tgt):
    with pytest.raises(TargetRefused):
        build_argv(NMAP, profile, tgt)


def test_argv_refuse_une_chaine():
    with pytest.raises(TargetRefused):
        build_argv(NMAP, "discovery", "192.168.1.0/24 --script vuln")  # type: ignore[arg-type]


@pytest.mark.parametrize("profile", list(PROFILES))
def test_profils_sans_script_ni_scan_par_connexion(profile):
    args = PROFILES[profile].args
    assert not any(a.startswith("--script") or a == "-sC" for a in args)
    assert "-sT" not in args  # faussé par l'antivirus du poste (ports mail interceptés)


# ─────────────────────────────── lecture du XML
HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE nmaprun>\n'
DISCOVERY_XML = HEAD + """<nmaprun scanner="nmap" version="7.991">
<host><status state="up" reason="arp-response"/><address addr="192.168.1.1" addrtype="ipv4"/><address addr="A2:00:00:00:00:01" addrtype="mac"/>
<hostnames><hostname name="router.lan" type="PTR"/></hostnames></host>
<host><status state="up" reason="arp-response"/><address addr="192.168.1.151" addrtype="ipv4"/><address addr="98:59:7A:00:00:02" addrtype="mac" vendor="Intel Corporate"/>
<hostnames><hostname name="DESKTOP-TEST.lan" type="PTR"/></hostnames></host>
<host><status state="down" reason="no-response"/><address addr="192.168.1.9" addrtype="ipv4"/></host>
<host><status state="up" reason="localhost-response"/><address addr="192.168.1.124" addrtype="ipv4"/><hostnames/></host>
<runstats><finished elapsed="2.76" exit="success"/><hosts up="3" down="253" total="256"/></runstats></nmaprun>"""

PORTS_XML = HEAD + """<nmaprun scanner="nmap"><host><status state="up"/><address addr="192.168.1.151" addrtype="ipv4"/><address addr="98:59:7A:00:00:02" addrtype="mac"/>
<ports><extraports state="closed" count="96"/>
<port protocol="tcp" portid="445"><state state="open"/><service name="microsoft-ds" product="Windows SMB" version="3.1.1"/></port>
<port protocol="tcp" portid="80"><state state="open"/><service name="http"/></port>
<port protocol="tcp" portid="81"><state state="closed"/><service name="hosts2-ns"/></port>
<port protocol="tcp" portid="99999"><state state="open"/></port>
<port protocol="sctp" portid="22"><state state="open"/></port>
</ports><os><osmatch name="Microsoft Windows 11" accuracy="96"><osclass type="general purpose" vendor="Microsoft"/></osmatch></os></host></nmaprun>"""


def test_lecture_decouverte():
    hosts = parse(DISCOVERY_XML)
    assert [h.ip for h in hosts] == ["192.168.1.1", "192.168.1.151", "192.168.1.124"]  # l'hôte « down » est écarté
    box, pc, me = hosts
    assert box.mac == BOX and box.vendor is None and box.hostname == "router.lan"
    assert pc.vendor == "Intel Corporate"
    assert me.mac is None


def test_lecture_ports_et_systeme():
    (pc,) = parse(PORTS_XML)
    assert pc.ports == (Port("tcp", 80, "http"), Port("tcp", 445, "microsoft-ds", "Windows SMB", "3.1.1"))  # fermé, hors plage, sctp : écartés
    assert pc.os_guess == "Microsoft Windows 11, 96 %" and pc.os_type == "general purpose"


def test_lecture_tronque_les_champs():
    xml = HEAD + f'<nmaprun><host><status state="up"/><address addr="192.168.1.5" addrtype="ipv4"/><hostnames><hostname name="{"a" * 1000}"/></hostnames></host></nmaprun>'
    assert len(parse(xml)[0].hostname) == 255


XXE = '<?xml version="1.0"?><!DOCTYPE nmaprun [<!ENTITY xxe SYSTEM "file:///C:/Windows/win.ini">]><nmaprun><host><status state="up"/><address addr="&xxe;" addrtype="ipv4"/></host></nmaprun>'
LAUGHS = '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><nmaprun>&c;</nmaprun>'


@pytest.mark.parametrize("xml", [XXE, LAUGHS, "<html><body>pas nmap</body></html>", "pas du XML", ""])
def test_xml_piege_ou_invalide_refuse(xml):
    with pytest.raises(ScanError):
        parse(xml)


# ─────────────────────────────── exécution (sans lancer Nmap)
class _Done:
    def __init__(self, code: int, out: bytes = b"", err: bytes = b""):
        self.returncode, self.stdout, self.stderr = code, out, err


def test_execution_paquets_bruts_refuses(monkeypatch):
    monkeypatch.setattr(nmap_runner.subprocess, "run", lambda *a, **k: _Done(1, err=b"dnet: Failed to open device eth0\nQUITTING!"))
    with pytest.raises(RawUnavailable):
        nmap_runner.run([NMAP, "-sn"], 5)


def test_execution_sans_shell_et_sortie_lue(monkeypatch):
    seen = {}

    def fake(argv, **kw):
        seen.update(kw, argv=argv)
        return _Done(0, DISCOVERY_XML.encode())

    monkeypatch.setattr(nmap_runner.subprocess, "run", fake)
    assert len(nmap_runner.run([NMAP, "-sn"], 5)) == 3
    assert seen["shell"] is False and isinstance(seen["argv"], list) and seen["timeout"] == 5


def test_execution_un_seul_scan_a_la_fois():
    assert nmap_runner._busy.acquire(blocking=False)
    try:
        with pytest.raises(nmap_runner.ScanBusy):
            nmap_runner.run([NMAP, "-sn"], 5)
    finally:
        nmap_runner._busy.release()


def test_executable_introuvable_ou_mal_nomme(tmp_path):
    fake = tmp_path / "calc.exe"
    fake.write_text("")
    assert nmap_runner.find_nmap(str(fake)) is None
    assert nmap_runner.find_nmap(str(tmp_path / "nmap.exe")) is None
    real = tmp_path / "nmap.exe"
    real.write_text("")
    assert nmap_runner.find_nmap(str(real)) == real.resolve()


# ─────────────────────────────── fabricants
PREFIXES = "# commentaire\n98597A Intel Corporate\nA8B1D4 Cisco Systems\nA8B1D41 Cisco Meraki\nA8B1D4123 Cisco Labs\nZZZZZZ Faux\n"


def test_prefixes_et_plus_long_prefixe():
    table = oui.parse_prefixes(PREFIXES)
    assert "ZZZZZZ" not in table
    assert oui.lookup("98:59:7a:01:02:03", table) == "Intel Corporate"
    assert oui.lookup("a8:b1:d4:12:34:56", table) == "Cisco Labs"
    assert oui.lookup("a8:b1:d4:1f:00:00", table) == "Cisco Meraki"
    assert oui.lookup("a8:b1:d4:00:00:00", table) == "Cisco Systems"
    assert oui.lookup("aa:b1:d4:00:00:00", table) is None  # MAC privée : pas de fabricant


# ─────────────────────────────── classement
@pytest.mark.parametrize(
    ("hints", "expected"),
    [
        ({"is_gateway": True, "randomized": True, "ports": frozenset({9100})}, "gateway"),
        ({"hostname": "iPhone.lan"}, "mobile"),
        ({"hostname": "Galaxy-A04.lan"}, "mobile"),
        ({"hostname": "Redmi-Note-13.lan"}, "mobile"),
        ({"hostname": "DESKTOP-4F2K.lan"}, "computer"),
        ({"hostname": "MacBook-Pro.lan", "ports": frozenset({5000, 7000})}, "computer"),  # AirPlay d'un Mac : pas une TV
        ({"hostname": "iPhone.lan", "ports": frozenset({9100})}, "printer"),  # port très spécifique d'abord
        ({"ports": frozenset({554})}, "camera"),
        ({"ports": frozenset({8009})}, "media"),
        ({"ports": frozenset({445})}, "computer"),
        ({"vendor": "Brother Industries"}, "printer"),
        ({"vendor": "McKay Brothers"}, "unknown"),  # mot entier : pas une imprimante
        ({"vendor": "Hangzhou Hikvision Digital Technology"}, "camera"),
        ({"vendor": "Espressif"}, "iot"),
        ({"vendor": "Intel Corporate"}, "computer"),
        ({"randomized": True}, "mobile"),
        ({"os_type": "phone"}, "mobile"),  # indice faible, en dernier
        ({}, "unknown"),
    ],
)
def test_classement(hints, expected):
    assert classify.kind(**{"is_gateway": False, "randomized": False, **hints}) == expected


# ─────────────────────────────── garde-fou
@pytest.mark.parametrize(
    ("kwargs", "blocked"),
    [
        ({"enabled": True, "nmap": Path(NMAP), "categories": ("private",)}, False),
        ({"enabled": True, "nmap": Path(NMAP), "categories": ("domain",)}, False),
        ({"enabled": True, "nmap": Path(NMAP), "categories": ("public",)}, True),
        ({"enabled": True, "nmap": Path(NMAP), "categories": ("private", "public")}, True),
        ({"enabled": True, "nmap": Path(NMAP), "categories": ()}, True),
        ({"enabled": True, "nmap": None, "categories": ("private",)}, True),
        ({"enabled": False, "nmap": Path(NMAP), "categories": ("private",)}, True),
    ],
)
def test_garde_fou(kwargs, blocked):
    assert (block_reason(**kwargs) is not None) is blocked


def test_garde_fou_public_explique_la_solution():
    assert "Privé" in block_reason(enabled=True, nmap=Path(NMAP), categories=("public",))


# ─────────────────────────────── fusion Nmap + ARP
def _obs(*devices: tuple[str, str], names=("Maison-5G",), categories=("private",)) -> Observation:
    neighbors = tuple(Neighbor(ip=ip, mac=mac, is_gateway=ip == WIFI.gateway, randomized=bool(int(mac[:2], 16) & 2)) for ip, mac in devices)
    return Observation(interface=WIFI, neighbors=neighbors, network_names=names, categories=categories)


def test_fusion():
    obs = _obs(("192.168.1.1", BOX), ("192.168.1.30", "98:59:7a:00:00:30"))
    hosts = [
        Host("192.168.1.124"),  # le poste
        Host("192.168.1.151", PC),
        Host("192.168.1.30"),  # vu sans MAC (« --unprivileged ») : MAC reprise de la table ARP
        Host("192.168.1.40"),  # sans MAC nulle part : pas d'identité
        Host("10.0.0.5", "98:59:7a:00:00:05"),  # hors sous-réseau
        Host("192.168.1.255", "98:59:7a:00:00:06"),  # diffusion
    ]
    assert {(n.ip, n.mac) for n in merge(obs, hosts).neighbors} == {("192.168.1.1", BOX), ("192.168.1.151", PC), ("192.168.1.30", "98:59:7a:00:00:30")}


def test_fusion_reponse_arp_de_nmap_prioritaire():
    """Nmap reçoit une réponse ARP fraîche : si la box répond avec une autre MAC, c'est elle qui compte."""
    (gw,) = merge(_obs(("192.168.1.1", BOX)), [Host("192.168.1.1", "3c:22:fb:00:00:66")]).neighbors
    assert gw.mac == "3c:22:fb:00:00:66" and gw.is_gateway


# ─────────────────────────────── ports (pur)
P_SMB, P_HTTP, P_TELNET = Port("tcp", 445, "microsoft-ds"), Port("tcp", 80, "http"), Port("tcp", 23, "telnet")


def test_ports_premier_scan_seuls_les_services_a_risque():
    (alert,) = assess_ports(device_id="k:pc", who="« PC » (192.168.1.151)", first_scan=True, known=set(), ports=(P_HTTP, P_SMB), now=NOW)
    assert alert["rule_id"] == "network-risky-service" and alert["severity"] == "high"
    assert alert["dedup_key"] == "net-risk:k:pc:tcp/445" and "SMB" in alert["rule_title"]


def test_ports_nouveau_port():
    (alert,) = assess_ports(device_id="k:cam", who="192.168.1.50", first_scan=False, known={("tcp", 80)}, ports=(P_HTTP, P_TELNET), now=NOW)
    assert alert["rule_id"] == "network-new-port" and alert["severity"] == "critical"
    assert alert["mitre"] and "Telnet" in alert["rule_title"]


def test_ports_inchanges_sans_alerte():
    assert assess_ports(device_id="k:pc", who="x", first_scan=False, known={("tcp", 80), ("tcp", 445)}, ports=(P_HTTP, P_SMB), now=NOW) == []


# ─────────────────────────────── réconciliation (base en mémoire)
def _with_db(monkeypatch, scenario):
    async def main():
        engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        maker = async_sessionmaker(engine, expire_on_commit=False)
        monkeypatch.setattr(service, "SessionLocal", maker)
        monkeypatch.setattr(active, "SessionLocal", maker)
        monkeypatch.setattr(service.notify, "enabled", lambda: False)
        monkeypatch.setitem(active._state, "raw", None)
        try:
            return await scenario(maker)
        finally:
            await engine.dispose()

    return asyncio.run(main())


PASSIVE = _obs(("192.168.1.1", BOX), ("192.168.1.151", PC))
PHONE_A, PHONE_B, INTRUDER = "da:00:00:00:00:0a", "da:00:00:00:00:0b", "3c:22:fb:00:00:99"


def test_premiere_decouverte_elargit_la_reference(monkeypatch):
    """Les appareils silencieux pour la table ARP mais présents depuis toujours n'alertent pas."""
    scans = [
        [Host("192.168.1.1", BOX), Host("192.168.1.151", PC), Host("192.168.1.20", PHONE_A, hostname="iPhone.lan"), Host("192.168.1.21", PHONE_B)],
        [Host("192.168.1.1", BOX), Host("192.168.1.151", PC), Host("192.168.1.20", PHONE_A), Host("192.168.1.66", INTRUDER)],
    ]
    monkeypatch.setattr(active.nmap_runner, "run", lambda argv, timeout: scans.pop(0))
    monkeypatch.setattr(active.neighbors, "observe", lambda: PASSIVE)

    async def scenario(maker):
        await service.reconcile(PASSIVE, now=NOW)  # référence passive : 2 appareils
        first = await active.discovery(PASSIVE, Path(NMAP))
        second = await active.discovery(PASSIVE, Path(NMAP))
        async with maker() as session:
            devices = {d.mac: d for d in (await session.scalars(select(NetDevice))).all()}
            (net,) = (await session.scalars(select(NetNetwork))).all()
            scans_rows = (await session.scalars(select(NetScan))).all()
        return first, second, devices, net, scans_rows

    first, second, devices, net, scan_rows = _with_db(monkeypatch, scenario)
    assert first == []
    assert [a["rule_id"] for a in second] == ["network-new-device"] and "192.168.1.66" in second[0]["rule_title"]
    assert devices[PHONE_A].status == "baseline" and devices[INTRUDER].status == "new"
    assert devices[PHONE_A].hostname == "iPhone.lan" and devices[PHONE_A].kind == "mobile"
    assert devices[BOX].kind == "gateway"
    assert net.active_baseline_at is not None
    assert [(s.profile, s.actor, s.ok, s.hosts_up) for s in scan_rows] == [("discovery", "système", True, 4), ("discovery", "système", True, 4)]


def test_decouverte_repli_sans_paquets_bruts(monkeypatch):
    calls = []

    def fake(argv, timeout):
        calls.append("--unprivileged" in argv)
        if not calls[-1]:
            raise RawUnavailable("Npcap réservé aux administrateurs")
        return [Host("192.168.1.151")]  # sans MAC : reprise de la table ARP

    monkeypatch.setattr(active.nmap_runner, "run", fake)
    monkeypatch.setattr(active.neighbors, "observe", lambda: PASSIVE)

    async def scenario(maker):
        await active.discovery(PASSIVE, Path(NMAP))
        with pytest.raises(ScanError, match="administrateurs"):
            await active.port_scan(PASSIVE, Path(NMAP))  # pas de scan par connexion faussé : refus explicite
        async with maker() as session:
            return [(s.profile, s.ok) for s in (await session.scalars(select(NetScan))).all()]

    rows = _with_db(monkeypatch, scenario)
    assert calls == [False, True] and active.raw_available() is False
    assert rows == [("discovery", False), ("discovery-unprivileged", True)]


def test_ports_reference_puis_nouveau_port(monkeypatch):
    async def scenario(maker):
        await service.reconcile(PASSIVE, now=NOW)
        key = service.network_key(PASSIVE)
        first = await active.ingest_ports(key, [Host("192.168.1.151", PC, ports=(P_HTTP, P_SMB))], NOW)
        second = await active.ingest_ports(key, [Host("192.168.1.151", PC, ports=(P_HTTP, P_SMB, P_TELNET))], NOW + timedelta(hours=6))
        third = await active.ingest_ports(key, [Host("192.168.1.151", PC, ports=(P_HTTP,))], NOW + timedelta(hours=12))  # 445 et 23 refermés
        fourth = await active.ingest_ports(key, [Host("192.168.1.151", PC, ports=(P_HTTP, P_TELNET))], NOW + timedelta(hours=18))  # 23 rouvert
        await service.raise_alerts(first + second)
        async with maker() as session:
            pc = await session.get(NetDevice, f"{key}:{PC}")
            ports = {(p.port, p.status) for p in (await session.scalars(select(NetPort))).all()}
            alerts = (await session.scalars(select(Alert))).all()
        return first, second, third, fourth, pc, ports, alerts

    first, second, third, fourth, pc, ports, alerts = _with_db(monkeypatch, scenario)
    assert [a["rule_id"] for a in first] == ["network-risky-service"]  # SMB au premier scan
    assert [a["rule_id"] for a in second] == ["network-new-port"] and second[0]["severity"] == "critical"
    assert third == [] and fourth == []  # un port refermé puis rouvert n'est pas une nouveauté
    assert ports == {(80, "baseline"), (445, "baseline"), (23, "new")}
    assert pc.ports_scanned_at is not None and pc.kind == "computer"
    assert len(alerts) == 2


def test_enrichissement_fabricant_passif(monkeypatch, tmp_path):
    exe = tmp_path / "nmap.exe"
    exe.write_text("")
    (tmp_path / "nmap-mac-prefixes").write_text("98597A Intel Corporate\n", encoding="utf-8")
    oui._table.cache_clear()

    async def scenario(maker):
        await service.reconcile(PASSIVE, now=NOW)
        await active.enrich(service.network_key(PASSIVE), [], exe)
        async with maker() as session:
            return {d.mac: d for d in (await session.scalars(select(NetDevice))).all()}

    devices = _with_db(monkeypatch, scenario)
    oui._table.cache_clear()
    assert devices[PC].vendor == "Intel Corporate" and devices[PC].kind == "computer"
    assert devices[BOX].vendor is None and devices[BOX].kind == "gateway"
