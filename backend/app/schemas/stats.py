"""Schéma de l'overview."""

from pydantic import BaseModel


class MitreDetail(BaseModel):
    """Technique détectée, enrichie pour la skyline ATT&CK de l'overview."""

    id: str
    name: str | None  # None si la technique n'est pas dans la base embarquée
    tactic: str | None  # identifiant ATT&CK (ex. "defense-evasion") ; None = non classée
    tactic_fr: str | None
    count: int


class OverviewStats(BaseModel):
    events_total: int
    events_24h: int
    alerts_total: int
    by_severity: dict[str, int]
    by_mitre: dict[str, int]
    by_channel: dict[str, int]
    events_series: list[int]  # 24 buckets horaires (ancien -> récent)
    alerts_series: list[int]
    mitre_details: list[MitreDetail] = []
