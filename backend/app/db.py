"""Accès PostgreSQL via SQLAlchemy 2.0 async."""

from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase

from app.config import get_settings

settings = get_settings()

engine = create_async_engine(settings.database_url, pool_pre_ping=True, echo=False)
SessionLocal = async_sessionmaker(engine, expire_on_commit=False)


class Base(DeclarativeBase):
    """Base déclarative pour tous les modèles ORM (users, incidents, ...)."""


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """Dépendance FastAPI : une session par requête, fermée automatiquement."""
    async with SessionLocal() as session:
        yield session
