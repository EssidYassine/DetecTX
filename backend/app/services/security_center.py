"""Produits de sécurité déclarés au Centre de sécurité Windows (antivirus, pare-feu tiers).

Lecture seule, sans droits administrateur : WMI `root/SecurityCenter2` (~40 ms). C'est la
même source que « Sécurité Windows » : elle dit quel antivirus protège réellement le poste
(Defender passe en mode passif quand un antivirus tiers est actif, ce qui est normal).
"""

import logging
import sys
import threading
import time
from dataclasses import dataclass

log = logging.getLogger(__name__)

_CACHE_TTL = 60.0  # s : l'état d'un antivirus change rarement
_cache: tuple[float, "Defense"] | None = None
_lock = threading.Lock()


@dataclass(frozen=True)
class Product:
    name: str
    kind: str  # antivirus | antispyware | firewall
    active: bool  # protection en temps réel activée
    up_to_date: bool  # signatures à jour (sans objet pour un pare-feu)


@dataclass(frozen=True)
class Defense:
    available: bool
    products: tuple[Product, ...] = ()
    error: str | None = None


def decode_state(state: int) -> tuple[bool, bool]:
    """productState (entier non documenté mais stable) -> (actif, signatures à jour).

    En hexadécimal sur 6 chiffres : [fournisseur][temps réel][signatures], ex. 0x041000 =
    antivirus, temps réel « 10 » (actif), signatures « 00 » (à jour) ; 0x060100 = temps réel
    « 01 » (désactivé / passif).
    """
    realtime = (state >> 8) & 0xFF
    signatures = state & 0xFF
    return realtime in (0x10, 0x11), signatures == 0x00


_CLASSES = (("AntiVirusProduct", "antivirus"), ("AntiSpywareProduct", "antispyware"), ("FirewallProduct", "firewall"))


def _read() -> Defense:
    if sys.platform != "win32":
        return Defense(available=False, error="Centre de sécurité Windows indisponible hors Windows.")
    import pythoncom
    import win32com.client

    def collect() -> list[Product]:
        # Objets COM confinés ici : libérés avant CoUninitialize (sinon avertissements « releasing IUnknown »).
        svc = win32com.client.Dispatch("WbemScripting.SWbemLocator").ConnectServer(".", "root/SecurityCenter2")
        found = []
        for cls, kind in _CLASSES:
            for p in svc.ExecQuery(f"SELECT displayName, productState FROM {cls}"):
                active, fresh = decode_state(int(p.productState))
                found.append(Product(name=str(p.displayName), kind=kind, active=active, up_to_date=fresh or kind == "firewall"))
        return found

    pythoncom.CoInitialize()
    try:
        return Defense(available=True, products=tuple(collect()))
    except Exception as exc:  # noqa: BLE001 - WMI absent (Windows Server) ou service arrêté
        log.warning("Centre de sécurité illisible : %s", exc)
        return Defense(available=False, error="Centre de sécurité Windows illisible.")
    finally:
        pythoncom.CoUninitialize()


def defense() -> Defense:
    """État des produits de sécurité, mis en cache _CACHE_TTL secondes."""
    global _cache
    with _lock:
        if _cache and time.monotonic() - _cache[0] < _CACHE_TTL:
            return _cache[1]
        state = _read()
        _cache = (time.monotonic(), state)
        return state
