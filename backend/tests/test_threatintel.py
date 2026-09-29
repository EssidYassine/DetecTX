"""Threat Intel : validation, listes publiques, correspondance locale, inventaire du poste,
vulnérabilités (KEV × NVD). Aucun appel réseau : les téléchargements sont simulés."""

import asyncio

import pytest
from fastapi import HTTPException

from app.schemas.intel import IntelResult, ProviderResult
from app.threatintel import feeds, overview, service, vulns
from app.threatintel.indicator import classify, is_public_ip
from app.threatintel.inventory import (
    Indicator,
    Inventory,
    Sighting,
    extract,
    from_connections,
)
from app.threatintel.matching import FeedIndex


# ─────────────────────────────── validation (rien d'injectable dans une URL d'API)
@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("8.8.8.8", ("ip", "8.8.8.8")),
        ("2001:4860:4860::8888", ("ip", "2001:4860:4860::8888")),
        ("Evil.Example.COM.", ("domain", "evil.example.com")),
        ("D41D8CD98F00B204E9800998ECF8427E", ("hash", "d41d8cd98f00b204e9800998ecf8427e")),
    ],
)
def test_classification_valide(raw, expected):
    assert classify(raw) == expected


@pytest.mark.parametrize("raw", ["../../users/me", "a/b", "http://x.com", "x y.com", "localhost", "exa_mple.com", "", "1" * 300, "evil.com/../x"])
def test_valeurs_refusees(raw):
    assert classify(raw) is None


def test_ip_publique():
    assert is_public_ip("8.8.8.8") and not is_public_ip("192.168.1.10") and not is_public_ip("::1") and not is_public_ip("169.254.1.1")


def test_recherche_en_ligne_refuse_ip_privee_et_invalide():
    with pytest.raises(service.LookupRefused):
        service.validate("192.168.1.10")
    with pytest.raises(service.LookupRefused):
        service.validate("../x")
    assert service.validate("8.8.8.8") == ("ip", "8.8.8.8")


def test_limite_de_debit():
    service._calls.clear()
    for k in range(service.RATE_LIMIT):
        service.check_rate("a@b", now=100.0 + k)
    with pytest.raises(service.RateLimited):
        service.check_rate("a@b", now=110.0)
    service.check_rate("a@b", now=100.0 + service.RATE_WINDOW + 10)  # fenêtre écoulée
    service.check_rate("autre@b", now=110.0)  # par utilisateur


# ─────────────────────────────── listes publiques
def test_analyseurs():
    assert feeds.parse_ips("# commentaire\n1.2.3.4\nnot-an-ip\n5.6.7.8 # x\n") == ["1.2.3.4", "5.6.7.8"]
    assert feeds.parse_hostfile("# URLhaus\n127.0.0.1\tevil.example.com\n127.0.0.1\tbad_host\n") == ["evil.example.com"]
    assert feeds.parse_hashes("# x\n" + "a" * 64 + "\nzz\n") == ["a" * 64]
    assert feeds.parse_drop('{"cidr":"1.10.16.0/20","sblid":"SBL1"}\n{"type":"metadata"}\nbroken\n') == ["1.10.16.0/20"]
    kev = feeds.parse_kev('{"vulnerabilities":[{"cveID":"CVE-2025-0411","vendorProject":"7-Zip","product":"7-Zip","extra":1}]}')
    assert kev == [{"cveID": "CVE-2025-0411", "vendorProject": "7-Zip", "product": "7-Zip", "vulnerabilityName": None, "dateAdded": None, "shortDescription": None, "requiredAction": None, "dueDate": None, "knownRansomwareCampaignUse": None}]


def test_correspondance_locale():
    idx = FeedIndex.build({"feodo": ("ip", ["1.2.3.4"]), "drop": ("cidr", ["1.10.16.0/20", "5.0.0.0/8"]), "urlhaus": ("domain", ["evil.com"]), "bazaar": ("hash", ["a" * 64])})
    assert idx.match("ip", "1.2.3.4") == ["feodo"]
    assert idx.match("ip", "1.10.17.9") == ["drop"] and idx.match("ip", "5.255.0.1") == ["drop"]
    assert idx.match("ip", "1.10.32.0") == []  # juste après la plage
    assert idx.match("domain", "cdn.sub.evil.com") == ["urlhaus"]  # sous-domaine d'un domaine listé
    assert idx.match("domain", "notevil.com") == []
    assert idx.match("hash", "A" * 64) == ["bazaar"]


def test_rafraichissement_simule_et_echec_sans_perte(tmp_path, monkeypatch):
    monkeypatch.setattr(feeds.settings, "intel_dir", str(tmp_path))
    good = {f.url: body for f, body in zip(feeds.FEEDS, ["1.2.3.4\n", "127.0.0.1\tevil.com\n", "b" * 64 + "\n", '{"cidr":"9.9.0.0/16"}\n', "7.7.7.7\n", '{"vulnerabilities":[]}'])}

    async def fetch_ok(url):
        return good[url]

    state = asyncio.run(feeds.refresh(fetch=fetch_ok))
    assert state["feodo"]["count"] == 1 and state["feodo"]["error"] is None
    assert state["kev"].get("error")  # KEV vide : « format inattendu », pas de fichier écrasé
    assert feeds.index().match("ip", "9.9.1.1") == ["drop"]

    async def fetch_fail(url):
        raise OSError("réseau coupé")

    state = asyncio.run(feeds.refresh(["feodo"], fetch=fetch_fail))
    assert state["feodo"]["error"] and feeds.load_entries("feodo") == ["1.2.3.4"]  # dernière version conservée
    feeds.set_enabled("feodo", False, actor="test")
    assert feeds.index().match("ip", "1.2.3.4") == []  # liste désactivée : ignorée
    assert not feeds.stale({f.id: {"enabled": False} for f in feeds.FEEDS})


# ─────────────────────────────── inventaire du poste
def test_inventaire_ne_garde_que_les_ip_publiques():
    inv = Inventory()
    from_connections(inv, [
        {"rip": "8.8.8.8", "rport": 443, "process": "chrome.exe", "pid": 12, "proto": "tcp", "status": "ESTABLISHED"},
        {"rip": "192.168.1.1", "rport": 53, "process": "svchost.exe", "pid": 4, "proto": "udp", "status": ""},
    ])
    assert list(inv.items) == ["8.8.8.8"]
    assert inv.items["8.8.8.8"].sightings[0].process == "chrome.exe"


def test_extraction_bornee():
    text = "download https://cdn.evil.com:8443/a.exe from 45.9.20.1 hash " + "c" * 64 + " and C:\\Windows\\x.dll"
    assert extract(text) == ["cdn.evil.com", "45.9.20.1", "c" * 64]
    assert extract("") == []


def test_verdict_et_disque_du_tamis(monkeypatch):
    monkeypatch.setattr(feeds, "index", lambda: FeedIndex.build({"feodo": ("ip", ["1.2.3.4"]), "tor": ("ip", ["6.6.6.6"])}))
    item = Indicator("1.2.3.4", "ip", [Sighting("connexion", "x")])
    assert overview.assess(item, None) == {"feeds": ["feodo"], "verdict": "malicious", "layer": 0, "online": None}
    assert overview.assess(Indicator("6.6.6.6", "ip"), None)["verdict"] == "suspicious"
    vt = IntelResult(indicator="9.9.9.9", type="ip", verdict="malicious", providers=[ProviderResult(provider="VirusTotal", available=True, verdict="malicious", detail="")])
    assert overview.assess(Indicator("9.9.9.9", "ip"), vt)["layer"] == 2
    assert overview.assess(Indicator("8.8.8.8", "ip"), None) == {"feeds": [], "verdict": "unknown", "layer": None, "online": None}


def test_analyse_en_ligne_limitee_a_l_inventaire(monkeypatch):
    from app.routers import threatintel as router

    async def fake_collect(session, force=False):
        return [Indicator("8.8.8.8", "ip", [Sighting("connexion", "x")])]

    monkeypatch.setattr(router.inventory, "collect", fake_collect)
    with pytest.raises(HTTPException) as exc:
        asyncio.run(router._machine_indicator(None, "1.1.1.1"))  # IOC arbitraire : refusé
    assert exc.value.status_code == 404
    assert asyncio.run(router._machine_indicator(None, " 8.8.8.8 ")).value == "8.8.8.8"


# ─────────────────────────────── vulnérabilités
SOFTWARE = [
    {"name": "7-Zip 26.02 (x64)", "version": "26.02", "publisher": "Igor Pavlov"},
    {"name": "Google Chrome", "version": "141.0.7390.66", "publisher": "Google LLC"},
    {"name": "Chrome Remote Desktop Host", "version": "140.0.7339.2", "publisher": "Google LLC"},
    {"name": "Microsoft Office Professional", "version": "16.0", "publisher": "Microsoft Corporation"},
    {"name": "Oracle VirtualBox 7.2.6", "version": "7.2.6", "publisher": "Oracle Corporation"},
]
KEV = [
    {"cveID": "CVE-2025-0411", "vendorProject": "7-Zip", "product": "7-Zip"},
    {"cveID": "CVE-2020-16017", "vendorProject": "Google", "product": "Chrome"},
    {"cveID": "CVE-2009-0238", "vendorProject": "Microsoft", "product": "Office"},  # exclu : Windows Update
    {"cveID": "CVE-2026-42897", "vendorProject": "Microsoft", "product": "Microsoft"},
    {"cveID": "CVE-1", "vendorProject": "Acme", "product": "App"},  # nom trop court
]


def test_candidats_kev_prudents():
    pairs = {(sw["name"], e["cveID"]) for sw, e in vulns.kev_candidates(SOFTWARE, KEV)}
    assert pairs == {("7-Zip 26.02 (x64)", "CVE-2025-0411"), ("Google Chrome", "CVE-2020-16017"), ("Chrome Remote Desktop Host", "CVE-2020-16017")}


def test_verification_de_version_nvd():
    nvd = {"configurations": [{"nodes": [{"cpeMatch": [
        {"vulnerable": True, "criteria": "cpe:2.3:a:netapp:active_iq_unified_manager:-:*:*:*:*:windows:*:*"},
        {"vulnerable": True, "criteria": "cpe:2.3:a:google:chrome:*:*:*:*:*:*:*:*", "versionEndExcluding": "86.0.4240.198"},
        {"vulnerable": True, "criteria": "cpe:2.3:a:7-zip:7-zip:*:*:*:*:*:*:*:*", "versionEndExcluding": "24.09"},
    ]}]}]}
    ranges = vulns.cpe_ranges(nvd)
    assert vulns.version_status("141.0.7390.66", "Google Chrome", ranges) == ("fixed", "86.0.4240.198")
    assert vulns.version_status("85.0.1", "Google Chrome", ranges) == ("vulnerable", "86.0.4240.198")
    assert vulns.version_status("26.02", "7-Zip 26.02 (x64)", ranges) == ("fixed", "24.09")  # le faux positif mesuré
    assert vulns.version_status("24.08", "7-Zip 24.08 (x64)", ranges) == ("vulnerable", "24.09")
    assert vulns.version_status("", "Google Chrome", ranges) == ("unknown", None)
    assert vulns.version_status("7.2.6", "Oracle VirtualBox 7.2.6", ranges) == ("unknown", None)  # aucune plage pour ce produit
    assert vulns.cmp_versions("10.0.2", "10.0.10") == -1 and vulns.cmp_versions("1.0", "1") == 0
