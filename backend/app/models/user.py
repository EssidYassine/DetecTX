"""Modèle utilisateur + rôles RBAC."""

import enum
from datetime import datetime

from sqlalchemy import Boolean, Enum, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class Role(str, enum.Enum):
    """Rôles RBAC (cf. cahier §Module 1)."""

    admin = "admin"
    analyst = "analyst"
    viewer = "viewer"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True, nullable=False)
    hashed_password: Mapped[str] = mapped_column(String(255), nullable=False)
    role: Mapped[Role] = mapped_column(Enum(Role), default=Role.viewer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)

    # MFA (TOTP) — secret nul tant que non activé
    mfa_enabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    mfa_secret: Mapped[str | None] = mapped_column(String(64), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime(), server_default=func.now(), nullable=False
    )
