"""Raccourci de lancement personnalisé (bouton défini par l'utilisateur)."""

from datetime import datetime

from sqlalchemy import String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class AppShortcut(Base):
    __tablename__ = "app_shortcuts"

    id: Mapped[int] = mapped_column(primary_key=True)
    label: Mapped[str] = mapped_column(String(120), nullable=False)
    target: Mapped[str] = mapped_column(String(500), nullable=False)  # chemin existant ou URL http(s)
    icon: Mapped[str | None] = mapped_column(String(8), nullable=True)  # emoji optionnel
    hotkey: Mapped[str | None] = mapped_column(String(64), nullable=True)  # ex. "ctrl+alt+k" (global)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
