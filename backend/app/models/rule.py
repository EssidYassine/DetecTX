"""Règle de détection personnalisée (créée depuis l'interface)."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, Boolean, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class CustomRule(Base):
    __tablename__ = "custom_rules"

    id: Mapped[int] = mapped_column(primary_key=True)
    rule_id: Mapped[str] = mapped_column(String(120), unique=True, index=True, nullable=False)
    title: Mapped[str] = mapped_column(String(255), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    level: Mapped[str] = mapped_column(String(20), default="medium", nullable=False)
    mitre: Mapped[str | None] = mapped_column(String(40), nullable=True)

    channel: Mapped[str | None] = mapped_column(String(255), nullable=True)
    event_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    keywords: Mapped[list[Any]] = mapped_column(JSON, default=list, nullable=False)
    threshold_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    threshold_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)

    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
