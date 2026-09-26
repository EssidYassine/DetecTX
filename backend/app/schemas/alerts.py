"""Schémas des alertes et de l'exécution du moteur de détection."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict


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


class AlertPage(BaseModel):
    total: int
    items: list[AlertOut]


class AlertStats(BaseModel):
    total: int
    by_severity: dict[str, int]
    by_mitre: dict[str, int]


class DetectionRunResult(BaseModel):
    rules_run: int
    alerts_created: int


class RuleInfo(BaseModel):
    id: str
    title: str
    severity: str
    mitre: str | None
    description: str | None
