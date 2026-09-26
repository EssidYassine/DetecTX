"""Modèle Alerte : résultat du moteur de détection sur les événements."""

from datetime import datetime

from sqlalchemy import DateTime, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class Alert(Base):
    __tablename__ = "alerts"

    id: Mapped[int] = mapped_column(primary_key=True)

    # Clé de déduplication (une même détection ne crée pas 2 alertes).
    dedup_key: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)

    rule_id: Mapped[str] = mapped_column(String(120), index=True, nullable=False)
    rule_title: Mapped[str] = mapped_column(String(255), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)  # critical|high|medium|low
    risk_score: Mapped[int] = mapped_column(Integer, nullable=False)
    mitre: Mapped[str | None] = mapped_column(String(40), nullable=True)

    # Contexte de l'événement déclencheur
    channel: Mapped[str | None] = mapped_column(String(255), nullable=True)
    event_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    event_record_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    event_timestamp: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    message: Mapped[str | None] = mapped_column(Text, nullable=True)

    status: Mapped[str] = mapped_column(String(20), default="new", nullable=False)  # new|ack|closed
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
