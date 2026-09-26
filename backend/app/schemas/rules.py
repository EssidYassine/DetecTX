"""Schémas des règles de détection personnalisées."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class RuleIn(BaseModel):
    title: str = Field(min_length=3, max_length=255)
    description: str | None = None
    level: str = Field(default="medium", pattern="^(critical|high|medium|low)$")
    mitre: str | None = Field(default=None, max_length=40)
    channel: str | None = None
    event_id: int | None = None
    keywords: list[str] = Field(default_factory=list)
    threshold_count: int | None = Field(default=None, ge=1)
    threshold_minutes: int | None = Field(default=None, ge=1)


class RuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_id: str
    title: str
    description: str | None
    level: str
    mitre: str | None
    channel: str | None
    event_id: int | None
    keywords: list[str]
    threshold_count: int | None
    threshold_minutes: int | None
    enabled: bool
    created_at: datetime
