"""Accès PostgreSQL via SQLAlchemy 2.0 async."""

from collections.abc import AsyncGenerator
from datetime import datetime, timezone

from sqlalchemy import DateTime
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase
from sqlalchemy.types import TypeDecorator

from app.config import get_settings

settings = get_settings()

engine = create_async_engine(settings.database_url, pool_pre_ping=True, echo=False)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    """Base déclarative pour tous les modèles ORM (users, incidents, ...)."""


class UTCDateTime(TypeDecorator[datetime]):
    """Horodatage toujours « aware », en UTC, quel que soit le moteur.

    PostgreSQL (timestamptz) le fait déjà ; SQLite ne garde pas le fuseau et rend des dates naïves,
    que l'API sérialisait sans « Z » : le navigateur les lisait en heure locale (décalage de 1 à 2 h).
    Écriture : ramenée en UTC. Lecture : une date naïve est une date UTC.
    """

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_bind_param(self, value: datetime | None, dialect) -> datetime | None:
        if value is not None and value.tzinfo is not None:
            return value.astimezone(timezone.utc)
        return value

    def process_result_value(self, value: datetime | None, dialect) -> datetime | None:
        if value is not None and value.tzinfo is None:
            return value.replace(tzinfo=timezone.utc)
        return value


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Dépendance FastAPI : une session par requête, fermée automatiquement."""
    async with SessionLocal() as session:
        yield session
