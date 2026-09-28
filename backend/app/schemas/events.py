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


class AgentInfo(BaseModel):
    """Identité de l'agent de collecte : sert au battement de cœur (santé de la collecte)."""

    computer: str = Field(min_length=1, max_length=255)
    version: str | None = Field(default=None, max_length=32)
    admin: bool | None = None
    interval_sec: int | None = Field(default=None, ge=1, le=3600)


class IngestBatch(BaseModel):
    # Un lot vide est un simple battement de cœur : « l'agent tourne, rien de nouveau ».
    events: list[IngestEvent] = Field(default_factory=list, max_length=1000)
    agent: AgentInfo | None = None


class IngestResult(BaseModel):
    indexed: int


class EventOut(BaseModel):
    id: str  # clé SQL ou _id OpenSearch
    timestamp: datetime
    title: str | None = None  # libellé de l'Event ID (catalogue), ex. « Nouveau service installé »
    summary: str | None = None  # phrase lisible (« Connecté au Wi-Fi « Maison » »)
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


class LinkedAlert(BaseModel):
    id: int
    rule_title: str
    severity: str
    status: str
    created_at: datetime


class EventDetail(EventOut):
    fields: dict[str, Any] = Field(default_factory=dict)
    knowledge: dict[str, Any] | None = None  # explication de l'Event ID (catalogue)
    alerts: list[LinkedAlert] = Field(default_factory=list)  # alertes levées sur cet événement


class HistogramAlert(BaseModel):
    bin: int
    lane: str  # thème
    severity: str
    count: int


class ReliefLane(BaseModel):
    key: str
    label: str


class EventHistogram(BaseModel):
    start: datetime  # début de la première tranche (UTC, heure pleine)
    hours: int
    lanes: list[ReliefLane]  # thèmes, de l'avant vers l'arrière du relief
    counts: dict[str, list[int]]  # thème -> nombre d'événements par heure
    alerts: list[HistogramAlert]


class FeedItem(BaseModel):
    id: str
    timestamp: datetime
    channel: str
    theme: str
    event_id: int | None
    title: str | None
    summary: str | None
    level: str  # intérêt pour l'analyste : info | low | medium | high
    count: int = 1  # répétitions repliées (même journal, même ID, même phrase, rapprochées)


class HuntOut(BaseModel):
    id: str
    title: str
    question: str
    channels: list[str]
    event_ids: list[int]
    keywords: list[str]
    attack: str | None
    level: str
    requires: list[str]
    count: int
