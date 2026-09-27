"""Journal d'audit : qui a fait quoi, quand (arrêts de processus, triages d'alertes…).

Les modules écrivent via logging.getLogger("detectx.audit"). Sans configuration, Python
ignore les messages INFO d'un logger sans handler : configure_audit_log() est appelée au
démarrage de l'API pour que chaque ligne soit réellement conservée (fichier tournant +
console). Une table d'audit en base, interrogeable depuis l'UI, reste à venir.
"""

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

AUDIT_LOGGER = "detectx.audit"
_FORMAT = "%(asctime)s %(levelname)s %(message)s"


def configure_audit_log(path: str) -> None:
    """Idempotent. `path` vide : console seulement (tests, conteneur qui collecte stdout)."""
    log = logging.getLogger(AUDIT_LOGGER)
    if getattr(log, "_detectx_configured", False):
        return
    log.setLevel(logging.INFO)
    formatter = logging.Formatter(_FORMAT)
    console = logging.StreamHandler()
    console.setFormatter(formatter)
    log.addHandler(console)
    if path:
        target = Path(path)
        target.parent.mkdir(parents=True, exist_ok=True)
        handler = RotatingFileHandler(target, maxBytes=5_000_000, backupCount=10, encoding="utf-8")
        handler.setFormatter(formatter)
        log.addHandler(handler)
    log._detectx_configured = True  # type: ignore[attr-defined]
