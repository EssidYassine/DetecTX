"""Enrichissement Threat Intelligence : VirusTotal, AbuseIPDB, MISP.

Chaque provider renvoie un ProviderResult ; si la clé n'est pas configurée,
`available=False` (verdict "unknown"). Résultats mis en cache 24h.
"""

import re
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.net import CA_BUNDLE
from app.models.threatintel import IntelCache
from app.schemas.intel import IntelResult, ProviderResult

settings = get_settings()
_TIMEOUT = httpx.Timeout(15.0)
_TTL = timedelta(hours=24)

_IPV4 = re.compile(r"^\d{1,3}(\.\d{1,3}){3}$")
_HASH = re.compile(r"^[a-fA-F0-9]{32}$|^[a-fA-F0-9]{40}$|^[a-fA-F0-9]{64}$")

_RANK = {"malicious": 4, "suspicious": 3, "known": 2, "clean": 1, "unknown": 0, "error": 0}


def detect_type(indicator: str) -> str:
    ind = indicator.strip()
    if _IPV4.match(ind):
        return "ip"
    if _HASH.match(ind):
        return "hash"
    return "domain"


async def _virustotal(client: httpx.AsyncClient, indicator: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="VirusTotal", available=False, verdict="unknown", detail="Clé non configurée")
    if not settings.virustotal_api_key:
        return p
    path = {"ip": "ip_addresses", "hash": "files", "domain": "domains"}[itype]
    try:
        r = await client.get(
            f"https://www.virustotal.com/api/v3/{path}/{indicator}",
            headers={"x-apikey": settings.virustotal_api_key},
        )
        p.available = True
        p.link = f"https://www.virustotal.com/gui/{'ip-address' if itype=='ip' else itype}/{indicator}"
        if r.status_code == 404:
            p.verdict, p.detail = "clean", "Inconnu de VirusTotal (aucune détection)"
            return p
        r.raise_for_status()
        stats = r.json()["data"]["attributes"]["last_analysis_stats"]
        mal = stats.get("malicious", 0)
        p.score = mal
        p.detail = f"{mal} moteurs malveillants, {stats.get('suspicious',0)} suspects"
        p.verdict = "malicious" if mal >= 3 else "suspicious" if mal > 0 else "clean"
    except Exception as exc:  # noqa: BLE001
        p.verdict, p.detail = "error", f"Erreur VT: {exc}"
    return p


async def _abuseipdb(client: httpx.AsyncClient, indicator: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="AbuseIPDB", available=False, verdict="unknown", detail="Clé non configurée")
    if itype != "ip":
        p.detail = "Applicable aux IP uniquement"
        return p
    if not settings.abuseipdb_api_key:
        return p
    try:
        r = await client.get(
            "https://api.abuseipdb.com/api/v2/check",
            headers={"Key": settings.abuseipdb_api_key, "Accept": "application/json"},
            params={"ipAddress": indicator, "maxAgeInDays": 90},
        )
        p.available = True
        p.link = f"https://www.abuseipdb.com/check/{indicator}"
        r.raise_for_status()
        d = r.json()["data"]
        score = d.get("abuseConfidenceScore", 0)
        p.score = score
        p.detail = f"Confiance abus {score}% · {d.get('totalReports',0)} signalements"
        p.verdict = "malicious" if score >= 50 else "suspicious" if score > 0 else "clean"
    except Exception as exc:  # noqa: BLE001
        p.verdict, p.detail = "error", f"Erreur AbuseIPDB: {exc}"
    return p


async def _misp(client: httpx.AsyncClient, indicator: str, itype: str) -> ProviderResult:
    p = ProviderResult(provider="MISP", available=False, verdict="unknown", detail="Non configuré")
    if not (settings.misp_url and settings.misp_key):
        return p
    try:
        r = await client.post(
            f"{settings.misp_url.rstrip('/')}/attributes/restSearch",
            headers={"Authorization": settings.misp_key, "Accept": "application/json"},
            json={"value": indicator, "limit": 5},
        )
        p.available = True
        r.raise_for_status()
        attrs = r.json().get("response", {}).get("Attribute", [])
        p.score = len(attrs)
        if attrs:
            p.verdict, p.detail = "known", f"{len(attrs)} attribut(s) MISP correspondant(s) (IOC connu)"
        else:
            p.verdict, p.detail = "clean", "Aucune correspondance MISP"
    except Exception as exc:  # noqa: BLE001
        p.verdict, p.detail = "error", f"Erreur MISP: {exc}"
    return p


async def lookup(session: AsyncSession, indicator: str, itype: str | None = None) -> IntelResult:
    indicator = indicator.strip()
    itype = itype or detect_type(indicator)

    cached = await session.scalar(select(IntelCache).where(IntelCache.indicator == indicator))
    if cached and cached.created_at.replace(tzinfo=timezone.utc) > datetime.now(timezone.utc) - _TTL:
        res = IntelResult(**cached.result)
        res.cached = True
        return res

    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=CA_BUNDLE) as client:
        providers = [
            await _virustotal(client, indicator, itype),
            await _abuseipdb(client, indicator, itype),
            await _misp(client, indicator, itype),
        ]

    verdict = max((p.verdict for p in providers), key=lambda v: _RANK.get(v, 0))
    result = IntelResult(indicator=indicator, type=itype, verdict=verdict, providers=providers)

    # cache (upsert simple)
    if cached:
        cached.result = result.model_dump()
        cached.itype = itype
    else:
        session.add(IntelCache(indicator=indicator, itype=itype, result=result.model_dump()))
    await session.commit()
    return result
