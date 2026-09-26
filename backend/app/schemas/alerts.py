"""Schémas des alertes, du triage et de l'exécution du moteur de détection."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

AlertStatus = Literal["new", "ack", "closed"]
Resolution = Literal["true_positive", "false_positive", "benign"]


class AlertOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_id: str
    rule_title: str
    severity: str
    risk_score: int
    mitre: str | None
    channel: str | None
    event_id: int | None
    event_record_id: int | None
    event_timestamp: datetime | None
    message: str | None
    status: str
    created_at: datetime
    resolution: str | None = None
    triaged_by: str | None = None
    triaged_at: datetime | None = None


class AlertPage(BaseModel):
    total: int
    items: list[AlertOut]


class AlertStats(BaseModel):
    total: int
    by_severity: dict[str, int]
    by_mitre: dict[str, int]
    by_status: dict[str, int] = {}


class TriageUpdate(BaseModel):
    """Changement de statut. Règle métier : on ne clôture pas sans conclusion, et une
    alerte rouverte ou en cours n'a pas de conclusion."""

    status: AlertStatus
    resolution: Resolution | None = None

    @model_validator(mode="after")
    def _resolution_matches_status(self) -> "TriageUpdate":
        if self.status == "closed" and self.resolution is None:
            raise ValueError("Une alerte clôturée exige une résolution (true_positive, false_positive ou benign).")
        if self.status != "closed" and self.resolution is not None:
            raise ValueError("La résolution n'est permise que pour une alerte clôturée.")
        return self


class BulkTriage(TriageUpdate):
    ids: list[int] = Field(min_length=1, max_length=200)


class BulkTriageResult(BaseModel):
    updated: int
    missing: list[int]


class TimelineDay(BaseModel):
    date: date
    critical: int = 0
    high: int = 0
    medium: int = 0
    low: int = 0


class AlertTimeline(BaseModel):
    days: list[TimelineDay]  # du plus ancien au plus récent (aujourd'hui inclus)


class DetectionRunResult(BaseModel):
    rules_run: int
    alerts_created: int


class RuleInfo(BaseModel):
    id: str
    title: str
    severity: str
    mitre: str | None
    description: str | None
