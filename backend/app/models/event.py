"""Modèle Event pour le backend local SQL (mode sans OpenSearch)."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class Event(Base):
    __tablename__ = "events"

    id: Mapped[int] = mapped_column(primary_key=True)
    ts: Mapped[datetime] = mapped_column(UTCDateTime(), index=True, nullable=False)
    channel: Mapped[str] = mapped_column(String(255), index=True, nullable=False)
    event_id: Mapped[int | None] = mapped_column(Integer, index=True, nullable=True)
    provider: Mapped[str | None] = mapped_column(String(255), nullable=True)
    computer: Mapped[str | None] = mapped_column(String(255), nullable=True)
    level: Mapped[str | None] = mapped_column(String(50), nullable=True)
    record_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Champs structurés (EventData Sysmon/Windows) pour l'évaluation Sigma champ-par-champ.
    fields: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict, nullable=False)
