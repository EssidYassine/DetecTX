"""Indicateurs de compromission : classification et validation STRICTES.

Toute valeur envoyée à un service externe passe par ici : une IP (v4/v6), un domaine conforme
(RFC 1035, 253 caractères max) ou une empreinte hexadécimale (MD5, SHA-1, SHA-256). Le reste
(« ../ », « a/b », URL, espaces…) est refusé : aucune injection dans une URL d'API.
"""

import ipaddress
import re
from typing import Literal

IndicatorType = Literal["ip", "domain", "hash"]

_HASH = re.compile(r"[0-9a-f]{32}|[0-9a-f]{40}|[0-9a-f]{64}")
_LABEL = re.compile(r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?")
_TLD = re.compile(r"[a-z]{2,63}|xn--[a-z0-9-]{1,59}")


def classify(value: str) -> tuple[IndicatorType, str] | None:
    """(type, valeur normalisée) ou None si la valeur n'est pas un indicateur valide."""
    v = (value or "").strip()
    if not v or len(v) > 253 or any(c.isspace() for c in v):
        return None
    try:
        return "ip", str(ipaddress.ip_address(v))
    except ValueError:
        pass
    low = v.lower()
    if _HASH.fullmatch(low):
        return "hash", low
    domain = low.rstrip(".")
    labels = domain.split(".")
    if len(labels) >= 2 and all(_LABEL.fullmatch(lab) for lab in labels) and _TLD.fullmatch(labels[-1]):
        return "domain", domain
    return None


def is_public_ip(value: str) -> bool:
    """Adresse routable sur Internet (ni privée, ni loopback, ni link-local, ni réservée…)."""
    try:
        return ipaddress.ip_address(value).is_global
    except ValueError:
        return False
