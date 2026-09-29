"""Enrichissement en ligne (à la demande) : VirusTotal, AbuseIPDB, MISP, AlienVault OTX.

Garde-fous (un indicateur part vers un tiers) :
  - validation stricte (indicator.classify) : aucune injection possible dans l'URL d'une API ;
  - une IP non publique n'est JAMAIS envoyée (réseau local = information interne) ;
  - limite de débit par utilisateur (quota gratuit VirusTotal : 4 requêtes / minute) ;
  - erreurs génériques côté client, détail dans le journal serveur ;
  - cache 24 h (table IntelCache).
Sans clé, un fournisseur répond « non configuré » (available=False) : rien n'est envoyé.
"""

import logging
import time
from collections import deque
from datetime import datetime, timedelta, timezone
from urllib.parse import quote

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.threatintel import IntelCache
from app.net import CA_BUNDLE
from app.schemas.intel import IntelResult, ProviderResult
from app.threatintel.indicator import classify, is_public_ip

log = logging.getLogger(__name__)
settings = get_settings()
_TIMEOUT = httpx.Timeout(15.0)
_TTL = timedelta(hours=24)
_RANK = {"malicious": 4, "suspicious": 3, "known": 2, "clean": 1, "unknown": 0, "error": 0}

RATE_LIMIT = 4  # recherches en ligne par utilisateur…
RATE_WINDOW = 60.0  # …et par minute
_calls: dict[str, deque[float]] = {}


class LookupRefused(ValueError):
    """Indicateur invalide ou non envoyable (IP privée…)."""


class RateLimited(Exception):
    pass


def check_rate(user: str, now: float | None = None) -> None:
    now = time.monotonic() if now is None else now
    q = _calls.setdefault(user, deque())
    while q and now - q[0] > RATE_WINDOW:
        q.popleft()
    if len(q) >= RATE_LIMIT:
        raise RateLimited()
    q.append(now)


def validate(indicator: str) -> tuple[str, str]:
    c = classify(indicator)
    if not c:
        raise LookupRefused("Indicateur invalide : IP, domaine ou empreinte (MD5, SHA-1, SHA-256) attendu.")
    if c[0] == "ip" and not is_public_ip(c[1]):
        raise LookupRefused("Adresse non publique : elle n'est jamais envoyée à un service externe.")
    return c


def _failed(p: ProviderResult, name: str, exc: Exception) -> ProviderResult:
    log.warning("threat intel %s : %s", name, exc)
    p.verdict, p.detail = "error", f"{name} n'a pas pu répondre."
    return p


async def _virustotal(client: httpx.AsyncClient, value: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="VirusTotal", available=False, verdict="unknown", detail="Clé non configurée (VIRUSTOTAL_API_KEY)")
    if not settings.virustotal_api_key:
        return p
    path = {"ip": "ip_addresses", "hash": "files", "domain": "domains"}[itype]
    try:
        r = await client.get(f"https://www.virustotal.com/api/v3/{path}/{quote(value, safe='')}", headers={"x-apikey": settings.virustotal_api_key})
        p.available = True
        p.link = f"https://www.virustotal.com/gui/{'ip-address' if itype == 'ip' else 'file' if itype == 'hash' else 'domain'}/{quote(value, safe='')}"
        if r.status_code == 404:
            p.verdict, p.detail = "clean", "Inconnu de VirusTotal (aucune détection)"
            return p
        r.raise_for_status()
        stats = r.json()["data"]["attributes"]["last_analysis_stats"]
        mal = int(stats.get("malicious", 0))
        p.score = mal
        p.detail = f"{mal} moteur(s) malveillant(s), {stats.get('suspicious', 0)} suspect(s)"
        p.verdict = "malicious" if mal >= 3 else "suspicious" if mal > 0 else "clean"
    except Exception as exc:  # noqa: BLE001
        return _failed(p, "VirusTotal", exc)
    return p


async def _abuseipdb(client: httpx.AsyncClient, value: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="AbuseIPDB", available=False, verdict="unknown", detail="Clé non configurée (ABUSEIPDB_API_KEY)")
    if itype != "ip":
        p.detail = "Applicable aux IP uniquement"
        return p
    if not settings.abuseipdb_api_key:
        return p
    try:
        r = await client.get("https://api.abuseipdb.com/api/v2/check", headers={"Key": settings.abuseipdb_api_key, "Accept": "application/json"}, params={"ipAddress": value, "maxAgeInDays": 90})
        p.available = True
        p.link = f"https://www.abuseipdb.com/check/{quote(value, safe='')}"
        r.raise_for_status()
        d = r.json()["data"]
        score = int(d.get("abuseConfidenceScore", 0))
        p.score = score
        p.detail = f"Confiance abus {score} % · {d.get('totalReports', 0)} signalement(s)"
        p.verdict = "malicious" if score >= 50 else "suspicious" if score > 0 else "clean"
    except Exception as exc:  # noqa: BLE001
        return _failed(p, "AbuseIPDB", exc)
    return p


async def _misp(client: httpx.AsyncClient, value: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="MISP", available=False, verdict="unknown", detail="Non configuré (MISP_URL, MISP_KEY)")
    if not (settings.misp_url and settings.misp_key):
        return p
    try:
        r = await client.post(f"{settings.misp_url.rstrip('/')}/attributes/restSearch", headers={"Authorization": settings.misp_key, "Accept": "application/json"}, json={"value": value, "limit": 5})
        p.available = True
        r.raise_for_status()
        attrs = r.json().get("response", {}).get("Attribute", [])
        p.score = len(attrs)
        p.verdict, p.detail = ("known", f"{len(attrs)} attribut(s) MISP correspondant(s)") if attrs else ("clean", "Aucune correspondance MISP")
    except Exception as exc:  # noqa: BLE001
        return _failed(p, "MISP", exc)
    return p


async def _otx(client: httpx.AsyncClient, value: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="AlienVault OTX", available=False, verdict="unknown", detail="Clé non configurée (OTX_API_KEY)")
    if not settings.otx_api_key:
        return p
    section = {"ip": "IPv6" if ":" in value else "IPv4", "domain": "domain", "hash": "file"}[itype]
    try:
        r = await client.get(f"https://otx.alienvault.com/api/v1/indicators/{section}/{quote(value, safe='')}/general", headers={"X-OTX-API-KEY": settings.otx_api_key})
        p.available = True
        p.link = f"https://otx.alienvault.com/indicator/{section.lower()}/{quote(value, safe='')}"
        r.raise_for_status()
        pulses = int(r.json().get("pulse_info", {}).get("count", 0))
        p.score = pulses
        p.verdict, p.detail = ("suspicious", f"Cité dans {pulses} rapport(s) OTX") if pulses else ("clean", "Aucun rapport OTX")
    except Exception as exc:  # noqa: BLE001
        return _failed(p, "OTX", exc)
    return p


async def cached(session: AsyncSession, value: str) -> IntelResult | None:
    row = await session.scalar(select(IntelCache).where(IntelCache.indicator == value))
    if row and row.created_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc) - _TTL:
        res = IntelResult(**row.result)
        res.cached = True
        return res
    return None


async def lookup(session: AsyncSession, indicator: str) -> IntelResult:
    """Interroge les fournisseurs configurés. `indicator` doit déjà être validé et autorisé."""
    itype, value = validate(indicator)
    hit = await cached(session, value)
    if hit:
        return hit
    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=CA_BUNDLE) as client:
        providers = [await f(client, value, itype) for f in (_virustotal, _abuseipdb, _misp, _otx)]
    verdict = max((p.verdict for p in providers), key=lambda v: _RANK.get(v, 0))
    result = IntelResult(indicator=value, type=itype, verdict=verdict, providers=providers)
    if any(p.available for p in providers):  # rien à mettre en cache si aucun fournisseur n'a répondu
        row = await session.scalar(select(IntelCache).where(IntelCache.indicator == value))
        if row:
            row.result, row.itype, row.created_at = result.model_dump(), itype, datetime.now(timezone.utc)
        else:
            session.add(IntelCache(indicator=value, itype=itype, result=result.model_dump()))
        await session.commit()
    return result
