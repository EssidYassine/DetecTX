"""Schémas des événements collectés sur l'hôte Windows."""

from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class IngestEvent(BaseModel):
    """Un événement normalisé envoyé par un collecteur (PowerShell / Fluent Bit)."""

    timestamp: datetime
    channel: str
    event_id: int | None = None
    provider: str | None = None
    computer: str | None = None
    level: str | None = None
    record_id: int | None = None
    message: str | None = None
    raw: dict[str, Any] = Field(default_factory=dict)


class IngestBatch(BaseModel):
    events: list[IngestEvent] = Field(min_length=1, max_length=1000)


class IngestResult(BaseModel):
    indexed: int


class EventOut(BaseModel):
    timestamp: datetime
    channel: str
    event_id: int | None = None
    provider: str | None = None
    computer: str | None = None
    level: str | None = None
    record_id: int | None = None
    message: str | None = None


class EventPage(BaseModel):
    total: int
    items: list[EventOut]


class EventStats(BaseModel):
    total: int
    last_24h: int
    by_channel: dict[str, int]
