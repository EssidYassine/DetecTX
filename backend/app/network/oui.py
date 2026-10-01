"""Fabricant d'une carte réseau d'après sa MAC, lu dans `nmap-mac-prefixes` (installé avec Nmap).

Règle d'or : la base IEEE est déjà maintenue par Nmap, on ne l'embarque pas. Elle sert aux
appareils vus seulement par la couche passive (table ARP), que Nmap n'a pas encore scannés.
Une MAC privée (« administrée localement ») n'a pas de fabricant : on ne devine pas.
"""

from __future__ import annotations

from functools import lru_cache
from pathlib import Path

from app.network.neighbors import is_randomized

_PREFIX_LENGTHS = (9, 7, 6)  # MA-S, MA-M, MA-L : du plus précis au plus large


def parse_prefixes(text: str) -> dict[str, str]:
    """« A8B1D4 Cisco Systems » -> {"A8B1D4": "Cisco Systems"} (pur)."""
    out: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        prefix, _, vendor = line.partition(" ")
        prefix = prefix.upper()
        if len(prefix) in _PREFIX_LENGTHS and all(c in "0123456789ABCDEF" for c in prefix) and vendor.strip():
            out[prefix] = vendor.strip()[:120]
    return out


@lru_cache(maxsize=2)
def _table(path: str) -> dict[str, str]:
    try:
        return parse_prefixes(Path(path).read_text(encoding="utf-8", errors="replace"))
    except OSError:
        return {}


def lookup(mac: str, table: dict[str, str]) -> str | None:
    if is_randomized(mac):
        return None
    hexa = mac.replace(":", "").upper()
    for size in _PREFIX_LENGTHS:
        if found := table.get(hexa[:size]):
            return found
    return None


def vendor(mac: str, nmap_exe: Path | None) -> str | None:
    if nmap_exe is None:
        return None
    return lookup(mac, _table(str(nmap_exe.parent / "nmap-mac-prefixes")))
