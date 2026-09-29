"""Référence de persistance : ce qui se relance au démarrage, tel qu'observé la première fois.

Sert à repérer une persistance NOUVELLE (clé Run, tâche, service… apparu après la référence) ou
MODIFIÉE (même entrée, commande changée : technique classique de détournement).
"""

from datetime import datetime

from sqlalchemy import String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class PersistenceSeen(Base):
    __tablename__ = "persistence_seen"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)  # empreinte stable (mécanisme, emplacement, nom)
    mechanism: Mapped[str] = mapped_column(String(20), index=True, nullable=False)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    fingerprint: Mapped[str] = mapped_column(String(64), nullable=False)  # empreinte de la commande
    status: Mapped[str] = mapped_column(String(20), default="baseline", nullable=False)  # baseline|new|modified
    first_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)
    changed_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
