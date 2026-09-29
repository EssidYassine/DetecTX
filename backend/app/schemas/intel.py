"""Schémas Threat Intelligence : indicateurs DU POSTE, listes publiques, vulnérabilités."""

from datetime import datetime

from pydantic import BaseModel


class ProviderResult(BaseModel):
    provider: str
    available: bool
    verdict: str  # clean | suspicious | malicious | known | unknown | error
    score: int | None = None
    detail: str
    link: str | None = None


class IntelResult(BaseModel):
    indicator: str
    type: str
    verdict: str  # verdict global
    providers: list[ProviderResult]
    cached: bool = False


class FeedStatus(BaseModel):
    id: str
    name: str
    kind: str
    verdict: str  # malicious | suspicious | reference
    license: str
    homepage: str
    description: str
    enabled: bool
    updated: datetime | None
    count: int | None
    error: str | None


class ProviderStatus(BaseModel):
    id: str
    name: str
    configured: bool
    env: str  # variable(s) d'environnement à renseigner


class SightingOut(BaseModel):
    kind: str  # connexion | programme | journal | alerte
    label: str
    process: str | None = None
    pid: int | None = None
    at: datetime | None = None
    ref: str | None = None


class IndicatorOut(BaseModel):
    value: str
    type: str  # ip | domain | hash
    verdict: str  # malicious | suspicious | unknown
    feeds: list[str]  # listes publiques qui le connaissent
    online: str | None  # verdict de la dernière analyse en ligne (cache 24 h)
    layer: int | None  # disque du tamis où il s'arrête (0 = listes, 1 AbuseIPDB, 2 VirusTotal, 3 MISP/OTX)
    sightings: int
    seen: SightingOut  # où il a été vu (première occurrence)


class IntelTotals(BaseModel):
    indicators: int
    ips: int
    domains: int
    hashes: int
    matches: int
    feeds_active: int
    providers_configured: int


class IntelOverview(BaseModel):
    generated_at: datetime
    feeds: list[FeedStatus]
    providers: list[ProviderStatus]
    indicators: list[IndicatorOut]
    totals: IntelTotals


class IndicatorDetail(IndicatorOut):
    all_sightings: list[SightingOut]
    feed_details: list[FeedStatus]
    lookup: IntelResult | None


class VulnReport(BaseModel):
    scanned_at: datetime | None
    running: bool
    os: dict
    windows_update: dict
    software_count: int
    kev_entries: int
    findings: list[dict]
