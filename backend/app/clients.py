"""Clients partagés vers OpenSearch et Redis (instanciés une fois)."""

from functools import lru_cache

import redis.asyncio as aioredis
from opensearchpy import AsyncOpenSearch

from app.config import get_settings

settings = get_settings()


@lru_cache
def get_opensearch() -> AsyncOpenSearch:
    """Client OpenSearch pour les events/logs (auth désactivée en dev)."""
    http_auth = None
    if settings.opensearch_use_ssl:
        http_auth = (settings.opensearch_user, settings.opensearch_initial_admin_password)
    return AsyncOpenSearch(
        hosts=[{"host": settings.opensearch_host, "port": settings.opensearch_port}],
        http_auth=http_auth,
        use_ssl=settings.opensearch_use_ssl,
        verify_certs=settings.opensearch_use_ssl,
        ssl_show_warn=False,
    )


@lru_cache
def get_redis() -> aioredis.Redis:
    """Client Redis (cache d'enrichissement + broker Celery)."""
    return aioredis.from_url(settings.redis_url, decode_responses=True)
