"""Point d'entrée de l'API DeTecTX."""

import asyncio
import contextlib
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from opensearchpy.exceptions import ConnectionError as OpenSearchConnectionError
from sqlalchemy import inspect, text

# Import des modèles pour qu'ils soient enregistrés dans Base.metadata
from app import (
    __version__,
    models,
)
from app.audit import configure_audit_log
from app.clients import get_opensearch, get_redis
from app.config import get_settings
from app.db import Base, engine
from app.routers import (
    ai,
    alerts,
    auth,
    detection,
    events,
    launcher,
    metrics,
    mitre,
    notifications,
    reports,
    rules,
    stats,
    system_control,
    threatintel,
)
from app.services import attack, winlog_collector
from app.services.events import ensure_events_index, repair_missing_messages

logger = logging.getLogger("detectx")
settings = get_settings()
configure_audit_log(settings.audit_log_path)


# Colonnes ajoutées après la création initiale des tables : create_all ne modifie pas une
# table existante. Migration légère, idempotente et portable (SQLite / PostgreSQL).
# TODO(phase-3+): remplacer par Alembic.
_LATE_COLUMNS = {
    "alerts": {
        "resolution": "VARCHAR(20)",
        "triaged_by": "VARCHAR(255)",
        "triaged_at": "TIMESTAMP",
    },
}


def _add_missing_columns(sync_conn) -> None:
    inspector = inspect(sync_conn)
    for table, columns in _LATE_COLUMNS.items():
        if not inspector.has_table(table):
            continue
        existing = {c["name"] for c in inspector.get_columns(table)}
        for name, ddl in columns.items():
            if name not in existing:
                sync_conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}"))
                logger.info("migration : colonne %s.%s ajoutée", table, name)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Ouvre/ferme proprement les connexions partagées au cycle de vie de l'app."""
    # MVP mono-hôte : création des tables au démarrage.
    # TODO(phase-3+): migrer vers Alembic pour un versioning de schéma propre.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_add_missing_columns)
        # Dédoublonnage de l'ingestion (journal, RecordID) : index créé s'il manque.
        await conn.execute(text("CREATE INDEX IF NOT EXISTS ix_events_channel_record ON events (channel, record_id)"))

    # Bootstrap de l'index OpenSearch — non bloquant s'il n'est pas encore up.
    try:
        await ensure_events_index()
    except Exception as exc:
        logger.warning("index events non initialisé (OpenSearch indisponible ?): %s", exc)

    # Événements stockés sans texte (éditeurs sans modèle de message) : message reconstitué.
    try:
        fixed = await repair_missing_messages()
        if fixed:
            logger.info("%d événement(s) sans message complété(s) à partir de leurs valeurs brutes", fixed)
    except Exception as exc:  # noqa: BLE001 - une réparation ratée ne doit pas empêcher le démarrage
        logger.warning("réparation des messages manquants impossible : %s", exc)

    logger.info("DeTecTX backend %s démarré (provider LLM: %s)", __version__, settings.llm_provider)
    collector = asyncio.create_task(winlog_collector.run_forever()) if winlog_collector.is_enabled() else None
    # Index des règles par technique ATT&CK (~4 s, surtout Sigma) : préchargé en tâche de fond
    # pour que la première ouverture de la page MITRE (et la première détection) soit immédiate.
    warmup = asyncio.create_task(asyncio.to_thread(attack.static_rules))
    yield
    warmup.cancel()
    if collector is not None:
        collector.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await collector
    await engine.dispose()
    await get_opensearch().close()
    await get_redis().aclose()


app = FastAPI(title="DeTecTX API", version=__version__, lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.exception_handler(OpenSearchConnectionError)
async def _opensearch_unavailable(request: Request, exc: OpenSearchConnectionError) -> JSONResponse:
    """OpenSearch injoignable -> 503 clair (au lieu d'un 500 sans CORS)."""
    return JSONResponse(
        status_code=503,
        content={"detail": "OpenSearch indisponible — démarrez la stack (docker compose up)."},
    )


app.include_router(auth.router)
app.include_router(events.router)
app.include_router(alerts.router)
app.include_router(detection.router)
app.include_router(ai.router)
app.include_router(threatintel.router)
app.include_router(reports.router)
app.include_router(notifications.router)
app.include_router(stats.router)
app.include_router(rules.router)
app.include_router(metrics.router)
app.include_router(mitre.router)
app.include_router(system_control.router)
app.include_router(launcher.router)


async def _check_postgres() -> bool:
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
        return True
    except Exception as exc:
        logger.warning("healthcheck postgres KO: %s", exc)
        return False


async def _check_opensearch() -> bool:
    try:
        return await get_opensearch().ping()
    except Exception as exc:
        logger.warning("healthcheck opensearch KO: %s", exc)
        return False


async def _check_redis() -> bool:
    try:
        return bool(await get_redis().ping())
    except Exception as exc:
        logger.warning("healthcheck redis KO: %s", exc)
        return False


@app.get("/health", tags=["system"])
async def health() -> dict:
    """Statut de l'API et de ses dépendances (pour le monitoring / Docker)."""
    checks = {
        "postgres": await _check_postgres(),
        "opensearch": await _check_opensearch(),
        "redis": await _check_redis(),
    }
    return {
        "service": "detectx-backend",
        "version": __version__,
        "status": "ok" if all(checks.values()) else "degraded",
        "dependencies": checks,
    }
