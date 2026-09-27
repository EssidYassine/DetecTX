"""Configuration centralisée, chargée depuis l'environnement (12-factor)."""

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # Override complet de l'URL de base (ex: SQLite en dev local). Prioritaire.
    database_url_override: str = Field(default="", validation_alias="DATABASE_URL")

    # Backend de stockage des événements : "opensearch" (défaut) ou "sql" (mode local sans Docker).
    events_backend: str = Field(default="opensearch", validation_alias="EVENTS_BACKEND")

    # Journal d'audit (arrêts de processus, triages…) : fichier tournant. Vide = console seule.
    audit_log_path: str = Field(default="logs/audit.log", validation_alias="AUDIT_LOG_PATH")

    # PostgreSQL
    postgres_user: str = "detectx"
    postgres_password: str = "detectx"
    postgres_db: str = "detectx"
    postgres_host: str = "postgres"
    postgres_port: int = 5432

    # OpenSearch
    opensearch_host: str = "opensearch"
    opensearch_port: int = 9200
    opensearch_user: str = "admin"
    opensearch_initial_admin_password: str = ""
    opensearch_use_ssl: bool = False

    # Redis
    redis_host: str = "redis"
    redis_port: int = 6379

    # Auth
    jwt_secret: str = "change_me"
    jwt_algorithm: str = "HS256"
    access_token_expire_minutes: int = 480  # 8 h : confortable en dev mono-hôte (raccourcir en prod)
    cors_origins: str = "http://localhost:3000"

    # LLM
    llm_provider: str = "ollama"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-3-5-haiku-latest"
    ollama_base_url: str = "http://host.docker.internal:11434"
    ollama_model: str = "llama3.1"

    # Threat Intelligence
    virustotal_api_key: str = ""
    abuseipdb_api_key: str = ""
    misp_url: str = ""
    misp_key: str = ""

    # Notifications
    discord_webhook_url: str = ""

    @property
    def database_url(self) -> str:
        if self.database_url_override:
            return self.database_url_override
        return (
            f"postgresql+asyncpg://{self.postgres_user}:{self.postgres_password}"
            f"@{self.postgres_host}:{self.postgres_port}/{self.postgres_db}"
        )

    @property
    def redis_url(self) -> str:
        return f"redis://{self.redis_host}:{self.redis_port}/0"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
