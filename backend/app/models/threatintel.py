"""Cache d'enrichissement Threat Intelligence."""

from datetime import datetime
from typing import Any

from sqlalchemy import JSON, DateTime, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class IntelCache(Base):
    __tablename__ = "threatintel"

    id: Mapped[int] = mapped_column(primary_key=True)
    indicator: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    itype: Mapped[str] = mapped_column(String(20), nullable=False)  # ip|hash|domain
    result: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
