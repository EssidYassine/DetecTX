"""Configuration des tests : environnement isolé, défini AVANT tout import de `app`
(app.db crée le moteur de base de données à l'import)."""

import os

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("EVENTS_BACKEND", "sql")
os.environ.setdefault("JWT_SECRET", "test-secret-not-for-production")
os.environ.setdefault("AUDIT_LOG_PATH", "")  # audit en console seulement : les tests n'écrivent pas le vrai journal
os.environ.setdefault("LOCAL_COLLECTOR", "false")  # les tests ne lisent pas les journaux du poste
os.environ.setdefault("INTEL_FEEDS", "false")  # aucun téléchargement pendant les tests
os.environ.setdefault("PERSISTENCE_WATCH", "false")  # pas de balayage du poste en tâche de fond
