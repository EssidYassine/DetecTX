"""Assemblage de la page : inventaire du poste × listes publiques × analyses en ligne en cache."""

from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import get_settings
from app.models.threatintel import IntelCache
from app.schemas.intel import FeedStatus, IntelResult, ProviderStatus
from app.threatintel import feeds
from app.threatintel.inventory import Indicator, Sighting

settings = get_settings()
_ORDER = {"malicious": 0, "suspicious": 1, "unknown": 2}
# Disque du tamis par fournisseur en ligne (0 = listes publiques locales).
_LAYER = {"AbuseIPDB": 1, "VirusTotal": 2, "MISP": 3, "AlienVault OTX": 3}


def providers() -> list[ProviderStatus]:
    return [
        ProviderStatus(id="abuseipdb", name="AbuseIPDB", configured=bool(settings.abuseipdb_api_key), env="ABUSEIPDB_API_KEY"),
        ProviderStatus(id="virustotal", name="VirusTotal", configured=bool(settings.virustotal_api_key), env="VIRUSTOTAL_API_KEY"),
        ProviderStatus(id="misp", name="MISP", configured=bool(settings.misp_url and settings.misp_key), env="MISP_URL, MISP_KEY"),
        ProviderStatus(id="otx", name="AlienVault OTX", configured=bool(settings.otx_api_key), env="OTX_API_KEY"),
    ]


def feed_statuses() -> list[FeedStatus]:
    state = feeds.load_state()
    out = []
    for f in feeds.FEEDS:
        s = state.get(f.id, {})
        out.append(
            FeedStatus(
                id=f.id, name=f.name, kind=f.kind, verdict=f.verdict, license=f.license, homepage=f.homepage, description=f.description,
                enabled=s.get("enabled", True), updated=s.get("updated"), count=s.get("count"), error=s.get("error"),
            )
        )
    return out


def assess(item: Indicator, online: IntelResult | None) -> dict:
    """Verdict et disque du tamis d'un indicateur (listes locales d'abord, puis analyses en ligne)."""
    matched = feeds.index().match(item.type, item.value)
    verdicts = {feeds.BY_ID[f].verdict for f in matched if f in feeds.BY_ID}
    verdict = "malicious" if "malicious" in verdicts else "suspicious" if "suspicious" in verdicts else "unknown"
    layer = 0 if matched else None
    if online:
        flagged = [p for p in online.providers if p.verdict in ("malicious", "suspicious", "known")]
        if layer is None and flagged:
            layer = min(_LAYER.get(p.provider, 3) for p in flagged)
        if verdict == "unknown" and flagged:
            verdict = "malicious" if any(p.verdict == "malicious" for p in flagged) else "suspicious"
    return {"feeds": matched, "verdict": verdict, "layer": layer, "online": online.verdict if online else None}


def _sighting(s: Sighting) -> dict:
    return {"kind": s.kind, "label": s.label, "process": s.process, "pid": s.pid, "at": s.at, "ref": s.ref}


async def online_results(session: AsyncSession, values: list[str]) -> dict[str, IntelResult]:
    if not values:
        return {}
    rows = (await session.scalars(select(IntelCache).where(IntelCache.indicator.in_(values)))).all()
    return {r.indicator: IntelResult(**r.result) for r in rows}


async def build(session: AsyncSession, items: list[Indicator]) -> dict:
    online = await online_results(session, [i.value for i in items])
    indicators = []
    for item in items:
        a = assess(item, online.get(item.value))
        indicators.append({"value": item.value, "type": item.type, **a, "sightings": len(item.sightings), "seen": _sighting(item.sightings[0])})
    indicators.sort(key=lambda i: (_ORDER[i["verdict"]], {"ip": 0, "hash": 1, "domain": 2}[i["type"]], i["value"]))
    fs, ps = feed_statuses(), providers()
    return {
        "generated_at": datetime.now(timezone.utc),
        "feeds": fs,
        "providers": ps,
        "indicators": indicators,
        "totals": {
            "indicators": len(indicators),
            "ips": sum(1 for i in indicators if i["type"] == "ip"),
            "domains": sum(1 for i in indicators if i["type"] == "domain"),
            "hashes": sum(1 for i in indicators if i["type"] == "hash"),
            "matches": sum(1 for i in indicators if i["verdict"] != "unknown"),
            "feeds_active": sum(1 for f in fs if f.enabled and f.count and f.kind != "kev"),
            "providers_configured": sum(1 for p in ps if p.configured),
        },
    }


async def detail(session: AsyncSession, item: Indicator) -> dict:
    online = (await online_results(session, [item.value])).get(item.value)
    a = assess(item, online)
    feed_ids = set(a["feeds"])
    return {
        "value": item.value,
        "type": item.type,
        **a,
        "sightings": len(item.sightings),
        "seen": _sighting(item.sightings[0]),
        "all_sightings": [_sighting(s) for s in item.sightings],
        "feed_details": [f for f in feed_statuses() if f.id in feed_ids],
        "lookup": online,
    }
