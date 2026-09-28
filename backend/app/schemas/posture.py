"""Posture de sécurité du poste : 5 piliers, constats sourcés, priorités d'action."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel

Tone = Literal["ok", "warn", "critical", "unknown"]
FindingLevel = Literal["critical", "high", "medium", "low", "ok"]
PillarKey = Literal["threats", "exposure", "defense", "visibility", "health"]


class Finding(BaseModel):
    """Un constat, toujours rattaché à sa source (règle du projet : rien sans preuve)."""

    id: str
    pillar: PillarKey
    level: FindingLevel  # ok = ce qui va bien (affiché dans le détail, jamais en priorité)
    title: str
    detail: str | None = None
    source: str  # d'où vient le constat (dossier d'alertes, règle de pare-feu, journal…)
    href: str | None = None  # page où agir
    action: str | None = None  # libellé du bouton
    at: datetime | None = None


class Pillar(BaseModel):
    key: PillarKey
    label: str
    weight: int
    score: int | None  # None = source indisponible
    tone: Tone
    headline: str
    href: str
    findings: list[Finding]


class Posture(BaseModel):
    score: int | None
    tone: Tone
    verdict: str
    summary: str
    pillars: list[Pillar]
    priorities: list[Finding]
    generated_at: datetime
