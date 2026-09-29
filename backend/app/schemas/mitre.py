"""Couverture MITRE ATT&CK : réelle (sources collectées) et théorique (toutes sources gérées)."""

from pydantic import BaseModel


class Tactic(BaseModel):
    id: str
    name: str


class SourceState(BaseModel):
    id: str
    label: str
    available: bool  # collectée aujourd'hui


class TechniqueCoverage(BaseModel):
    id: str
    name: str | None
    tactics: list[str]
    district: str  # quartier de la ruche (1re tactique dans l'ordre de la kill chain)
    desc: str | None
    url: str
    by_source: dict[str, int]  # règles par source de données (sans les inertes)
    theoretical: int
    effective: int
    inert: int
    alerts: int
    alerts_open: int


class PlanItem(BaseModel):
    source: str
    label: str
    how: str | None
    rules: int  # règles débloquées
    techniques: int  # techniques qui passeraient de « aveugle » à « couverte »


class CoverageTotals(BaseModel):
    techniques: int
    techniques_theoretical: int
    techniques_effective: int
    techniques_observed: int
    rules_theoretical: int
    rules_effective: int
    rules_inert: int


class Coverage(BaseModel):
    attack_version: str | None
    tactics: list[Tactic]
    sources: list[SourceState]
    techniques: list[TechniqueCoverage]
    totals: CoverageTotals
    plan: list[PlanItem]
    observed_uncovered: list[str]  # techniques vues dans des alertes mais sans règle active


class TechniqueRule(BaseModel):
    id: str
    title: str
    severity: str
    origin: str  # sigma | interne | perso
    source: str
    active: bool
    reason: str | None  # pourquoi la règle est aveugle


class TechniqueDetail(TechniqueCoverage):
    rules: list[TechniqueRule]
