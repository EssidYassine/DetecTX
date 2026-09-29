"""Inventaire des indicateurs de NOTRE machine (et seulement d'elle).

  - IP publiques des connexions réseau actives (avec le processus qui les ouvre) ;
  - empreintes SHA-256 des programmes en cours d'exécution ;
  - domaines / IP / empreintes cités dans les journaux (7 jours) et les messages d'alerte.
Aucune donnée n'est envoyée : l'inventaire est comparé localement aux listes (feeds.index()).
"""

import asyncio
import hashlib
import logging
import os
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.threatintel.indicator import classify, is_public_ip

log = logging.getLogger(__name__)

MAX_INDICATORS = 2000
MAX_HASH_FILES = 300
MAX_HASH_BYTES = 200 * 1024 * 1024
SNAPSHOT_TTL = 120.0  # s

_URL = re.compile(r"\bhttps?://([A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:]{2,45}\])(?::\d{1,5})?", re.IGNORECASE)
_IPV4 = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_SHA256 = re.compile(r"\b[0-9A-Fa-f]{64}\b")


@dataclass
class Sighting:
    kind: str  # connexion | programme | journal | alerte
    label: str
    process: str | None = None
    pid: int | None = None
    at: datetime | None = None
    ref: str | None = None  # identifiant d'événement ou d'alerte (lien)


@dataclass
class Indicator:
    value: str
    type: str
    sightings: list[Sighting] = field(default_factory=list)


class Inventory:
    def __init__(self) -> None:
        self.items: dict[str, Indicator] = {}

    def add(self, raw: str, sighting: Sighting) -> None:
        c = classify(raw)
        if not c:
            return
        itype, value = c
        if itype == "ip" and not is_public_ip(value):
            return  # réseau local, loopback… : ni un IOC externe, ni à envoyer nulle part
        item = self.items.get(value)
        if item is None:
            if len(self.items) >= MAX_INDICATORS:
                return
            item = self.items[value] = Indicator(value, itype)
        if len(item.sightings) < 20:
            item.sightings.append(sighting)


def extract(text: str) -> list[str]:
    """Hôtes d'URL, IPv4 et SHA-256 cités dans un texte (bornés, sans faux « domaines » libres)."""
    if not text:
        return []
    text = text[:20000]
    out = [m.group(1).strip("[]") for m in _URL.finditer(text)]
    out += _IPV4.findall(text)
    out += _SHA256.findall(text)
    return out


# ─────────────────────────────── sources
def from_connections(inv: Inventory, conns: list[dict]) -> None:
    for c in conns:
        label = f"{c.get('process') or 'processus inconnu'} → {c['rip']}:{c['rport']} ({c.get('proto', 'tcp').upper()} {c.get('status', '')})".strip()
        inv.add(c["rip"], Sighting("connexion", label, c.get("process"), c.get("pid"), datetime.now(timezone.utc)))


_hash_cache: dict[tuple[str, int, int], str] = {}


def sha256_file(path: str) -> str | None:
    """Empreinte d'un exécutable, mise en cache par (chemin, taille, date de modification)."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    if st.st_size > MAX_HASH_BYTES:
        return None
    key = (path, st.st_size, int(st.st_mtime))
    if key in _hash_cache:
        return _hash_cache[key]
    h = hashlib.sha256()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                h.update(chunk)
    except OSError:
        return None
    _hash_cache[key] = digest = h.hexdigest()
    return digest


def from_processes(inv: Inventory, procs: list[dict]) -> None:
    seen: dict[str, dict] = {}
    for p in procs:
        exe = p.get("exe")
        if exe and exe not in seen and len(seen) < MAX_HASH_FILES:
            seen[exe] = p
    for exe, p in seen.items():
        digest = sha256_file(exe)
        if digest:
            inv.add(digest, Sighting("programme", f"{os.path.basename(exe)} en cours (PID {p.get('pid')}) — {exe}", p.get("name"), p.get("pid"), datetime.now(timezone.utc)))


# ─────────────────────────────── instantané (mis en cache)
_snapshot: tuple[float, list[Indicator]] | None = None
_lock = asyncio.Lock()


async def collect(session: AsyncSession, force: bool = False) -> list[Indicator]:
    """Inventaire du poste, recalculé au plus toutes les SNAPSHOT_TTL secondes."""
    global _snapshot
    async with _lock:
        if not force and _snapshot and time.monotonic() - _snapshot[0] < SNAPSHOT_TTL:
            return _snapshot[1]
        from app.models.alert import Alert
        from app.services import events as events_svc
        from app.services import metrics

        inv = Inventory()
        try:
            conns = await asyncio.to_thread(metrics.connections, 2000)
            from_connections(inv, conns["connections"])
        except Exception as exc:  # noqa: BLE001 - une source indisponible n'empêche pas les autres
            log.warning("inventaire : connexions illisibles (%s)", exc)
        try:
            procs = await asyncio.to_thread(metrics.top_processes, 2000)
            await asyncio.to_thread(from_processes, inv, procs)
        except Exception as exc:  # noqa: BLE001
            log.warning("inventaire : empreintes des programmes indisponibles (%s)", exc)
        try:
            page = await events_svc.search_events(keywords=["http://", "https://"], minutes=60 * 24 * 7, limit=500)
            for e in page.items:
                for raw in extract(e.message or ""):
                    inv.add(raw, Sighting("journal", e.summary or e.title or f"Événement {e.event_id}", at=e.timestamp, ref=e.id))
        except Exception as exc:  # noqa: BLE001
            log.warning("inventaire : journaux illisibles (%s)", exc)
        rows = (await session.execute(select(Alert.id, Alert.rule_title, Alert.message, Alert.created_at).order_by(Alert.id.desc()).limit(1000))).all()
        for aid, title, message, created in rows:
            for raw in extract(message or ""):
                inv.add(raw, Sighting("alerte", title, at=created, ref=str(aid)))
        items = list(inv.items.values())
        _snapshot = (time.monotonic(), items)
        return items
