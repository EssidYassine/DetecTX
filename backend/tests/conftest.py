"""Configuration des tests : environnement isolé, défini AVANT tout import de `app`
(app.db crée le moteur de base de données à l'import)."""

import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("EVENTS_BACKEND", "sql")
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production")
