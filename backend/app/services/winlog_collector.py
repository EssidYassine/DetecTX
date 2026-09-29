"""Collecteur intégré : le backend lit lui-même, en continu, les journaux Windows de l'hôte.

Pourquoi : l'agent PowerShell doit être lancé à la main (avec un mot de passe) ; s'il ne tourne
pas, DeTecTX est aveugle. Le backend tourne déjà sur la machine surveillée : il lit directement
les journaux accessibles SANS droits administrateur (Système, Applications, PowerShell,
Defender, pare-feu, sessions, Wi-Fi, périphériques, BITS, WMI…). Le journal Security (admin)
et les fichiers surveillés restent le rôle de l'agent ; l'ingestion déduplique les deux.

Fonctionnement :
- lecture incrémentale par EventRecordID, marque-page par journal persisté sur disque
  (pas de trou ni de doublon au redémarrage) ; premier passage = dernières 24 h ;
- journal vidé ou recyclé (RecordID qui recule) : on repart de la fenêtre de 24 h ;
- journaux bavards filtrés sur les Event IDs utiles ;
- appels bloquants pywin32 exécutés hors de la boucle asyncio (asyncio.to_thread) ;
- battement de cœur « collecteur intégré » à chaque cycle (santé de la collecte).
"""

import asyncio
import json
import logging
import os
import socket
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from app.config import get_settings
from app.detection.event_narrator import fallback_message
from app.schemas.events import IngestEvent
from app.services import collection, events

logger = logging.getLogger("detectx.collector")
settings = get_settings()

INTERVAL_SEC = 10
BACKFILL_MS = 24 * 3600 * 1000
MAX_PER_CYCLE = 500  # par journal : un journal qui déborde est rattrapé au cycle suivant
_NS = "{http://schemas.microsoft.com/win/2004/08/events/event}"
_LEVELS = {0: "Information", 1: "Critical", 2: "Error", 3: "Warning", 4: "Information", 5: "Verbose"}


@dataclass(frozen=True)
class Source:
    channel: str
    event_ids: tuple[int, ...] = ()  # vide = tous


SOURCES: tuple[Source, ...] = (
    Source("System"),
    Source("Application"),
    Source("Security"),  # lisible seulement si le backend est administrateur
    Source("Microsoft-Windows-PowerShell/Operational", (4103, 4104)),
    Source("Windows PowerShell", (400, 403)),
    Source("Microsoft-Windows-Sysmon/Operational"),
    Source("Microsoft-Windows-Windows Defender/Operational", (1006, 1015, 1116, 1117, 1118, 5001, 5007, 5010, 5012)),
    Source("Microsoft-Windows-Windows Firewall With Advanced Security/Firewall", (2004, 2005, 2006, 2033, 2052, 2097, 2099)),
    Source("Microsoft-Windows-TerminalServices-LocalSessionManager/Operational", (21, 22, 23, 24, 25)),
    Source("Microsoft-Windows-Bits-Client/Operational", (3, 59, 60)),
    Source("Microsoft-Windows-Kernel-PnP/Configuration", (400, 410, 420)),
    Source("Microsoft-Windows-WLAN-AutoConfig/Operational", (8001, 8003)),
    Source("Microsoft-Windows-NetworkProfile/Operational", (10000, 10001)),
    Source("Microsoft-Windows-CodeIntegrity/Operational", (3033, 3077)),
    Source("Microsoft-Windows-WMI-Activity/Operational", (5860, 5861)),
    Source("Microsoft-Windows-TaskScheduler/Operational", (106, 140, 141)),
)

# État par journal : « ok », « denied » (droits), « absent » (journal inexistant), « error ».
_status: dict[str, str] = {}


def channel_status() -> dict[str, str]:
    return dict(_status)


# ─────────────────────────────── lecture (bloquante, exécutée en thread)
def _xpath(source: Source, after: int | None) -> str:
    conds = []
    if source.event_ids:
        conds.append("(" + " or ".join(f"EventID={i}" for i in source.event_ids) + ")")
    conds.append(f"EventRecordID>{after}" if after is not None else f"TimeCreated[timediff(@SystemTime) <= {BACKFILL_MS}]")
    return f"*[System[{' and '.join(conds)}]]"


def parse_event_xml(xml: str) -> dict:
    """XML d'un événement Windows -> dictionnaire (en-tête System + EventData/UserData)."""
    root = ET.fromstring(xml)
    system = root.find(f"{_NS}System")
    provider = system.find(f"{_NS}Provider")
    created = system.find(f"{_NS}TimeCreated").get("SystemTime")
    level = system.findtext(f"{_NS}Level")
    fields: dict[str, str] = {}
    data = root.find(f"{_NS}EventData")
    if data is not None:
        for i, d in enumerate(data.findall(f"{_NS}Data"), start=1):
            fields[d.get("Name") or f"Data{i}"] = (d.text or "").strip()
    user = root.find(f"{_NS}UserData")
    if user is not None and len(user):
        for child in list(user[0]):
            fields[child.tag.split("}")[-1]] = (child.text or "").strip()
    return {
        "timestamp": datetime.fromisoformat(created.replace("Z", "+00:00")),
        "channel": system.findtext(f"{_NS}Channel"),
        "event_id": int(system.findtext(f"{_NS}EventID")),
        "provider": provider.get("Name") if provider is not None else None,
        "computer": system.findtext(f"{_NS}Computer"),
        "level": _LEVELS.get(int(level), "Information") if level and level.isdigit() else None,
        "record_id": int(system.findtext(f"{_NS}EventRecordID")),
        "fields": fields,
    }


class _Formatter:
    """Texte des messages via les métadonnées de chaque fournisseur (mises en cache)."""

    def __init__(self):
        self._meta: dict[str, object] = {}

    def message(self, handle, provider: str | None) -> str | None:
        import win32evtlog

        if not provider:
            return None
        try:
            meta = self._meta.get(provider)
            if meta is None:
                meta = win32evtlog.EvtOpenPublisherMetadata(provider)
                self._meta[provider] = meta
            return win32evtlog.EvtFormatMessage(meta, handle, win32evtlog.EvtFormatMessageEvent)
        except Exception:
            return None


def _newest_record(channel: str) -> int | None:
    import win32evtlog

    handle = win32evtlog.EvtQuery(channel, win32evtlog.EvtQueryReverseDirection, "*")
    newest = win32evtlog.EvtNext(handle, 1, -1, 0)
    if not newest:
        return None
    return parse_event_xml(win32evtlog.EvtRender(newest[0], win32evtlog.EvtRenderEventXml))["record_id"]


def read_source(source: Source, after: int | None, formatter: _Formatter) -> tuple[list[IngestEvent], int | None]:
    """Nouveaux événements d'un journal depuis `after` (None = fenêtre de 24 h)."""
    import pywintypes
    import win32evtlog

    try:
        newest = _newest_record(source.channel)
        if after is not None and newest is not None and newest < after:
            after = None  # journal vidé ou recyclé : on repart de la fenêtre récente
        handle = win32evtlog.EvtQuery(source.channel, win32evtlog.EvtQueryForwardDirection, _xpath(source, after))
    except pywintypes.error as e:
        _status[source.channel] = {5: "denied", 15007: "absent", 15002: "absent"}.get(e.winerror, "error")
        return [], after
    _status[source.channel] = "ok"

    out: list[IngestEvent] = []
    last = after if after is not None else newest
    while len(out) < MAX_PER_CYCLE:
        batch = win32evtlog.EvtNext(handle, 64, -1, 0)
        if not batch:
            break
        for h in batch:
            try:
                ev = parse_event_xml(win32evtlog.EvtRender(h, win32evtlog.EvtRenderEventXml))
            except (ET.ParseError, AttributeError, ValueError):
                continue
            out.append(
                IngestEvent(
                    timestamp=ev["timestamp"],
                    channel=ev["channel"] or source.channel,
                    event_id=ev["event_id"],
                    provider=ev["provider"],
                    computer=ev["computer"],
                    level=ev["level"],
                    record_id=ev["record_id"],
                    # Éditeur sans modèle de texte : valeurs brutes, comme l'Observateur d'événements.
                    message=formatter.message(h, ev["provider"]) or fallback_message(ev["fields"], ev["provider"]),
                    raw=ev["fields"],
                )
            )
            last = max(last or 0, ev["record_id"])
    return out, last


# ─────────────────────────────── état persistant (marque-pages)
def _state_path() -> Path:
    return Path(settings.collector_state_path)


def load_state() -> dict[str, int]:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
        return {k: int(v) for k, v in data.items() if isinstance(v, int)}
    except (OSError, ValueError):
        return {}


def save_state(state: dict[str, int]) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=1), encoding="utf-8")
    os.replace(tmp, path)  # écriture atomique : pas d'état à moitié écrit


def collect_once(state: dict[str, int], formatter: _Formatter) -> list[IngestEvent]:
    batch: list[IngestEvent] = []
    for source in SOURCES:
        items, last = read_source(source, state.get(source.channel), formatter)
        batch.extend(items)
        if last is not None:
            state[source.channel] = last
    return batch


# ─────────────────────────────── boucle de fond
def _is_admin() -> bool:
    from app.services import fw_helper

    return fw_helper.is_admin()


async def run_forever() -> None:
    if sys.platform != "win32":
        logger.info("collecteur intégré inactif : hôte non Windows")
        return
    formatter = _Formatter()
    state = load_state()
    host = socket.gethostname()
    admin = _is_admin()
    logger.info("collecteur intégré démarré (%d journaux, administrateur=%s)", len(SOURCES), admin)
    while True:
        try:
            batch = await asyncio.to_thread(collect_once, state, formatter)
            for start in range(0, len(batch), 500):
                await events.index_events(batch[start : start + 500])
            save_state(state)
            collection.record(host, kind="integre", version="intégré", admin=admin, interval_sec=INTERVAL_SEC)
            if batch:
                logger.info("collecteur intégré : %d événements", len(batch))
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("collecteur intégré : cycle en erreur")
        await asyncio.sleep(INTERVAL_SEC)


def is_enabled() -> bool:
    return settings.local_collector and sys.platform == "win32"

