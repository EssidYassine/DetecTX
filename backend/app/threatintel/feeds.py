"""Listes publiques de renseignement : téléchargées, jamais affichées, comparées EN LOCAL.

Registre codé en dur (aucune URL fournie par l'utilisateur : pas de SSRF). Téléchargement HTTPS,
taille plafonnée, écriture atomique dans `settings.intel_dir/feeds/` ; une liste en échec garde sa
dernière version valide. Rafraîchissement au démarrage puis toutes les 12 h (INTEL_FEEDS=false
pour couper). Rien de la machine n'est envoyé : on télécharge des listes, c'est tout.
"""

import asyncio
import json
import logging
import os
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

import httpx

from app.config import get_settings
from app.net import CA_BUNDLE
from app.threatintel.indicator import classify
from app.threatintel.matching import FeedIndex

log = logging.getLogger(__name__)
audit = logging.getLogger("detectx.audit")
settings = get_settings()

REFRESH_EVERY = timedelta(hours=12)
MAX_BYTES = 20 * 1024 * 1024
USER_AGENT = "DeTecTX/0.1 (listes publiques de renseignement)"


def _data_lines(text: str) -> list[str]:
    return [ln.strip() for ln in text.splitlines() if ln.strip() and not ln.lstrip().startswith(("#", ";", "//"))]


def parse_ips(text: str) -> list[str]:
    out = []
    for ln in _data_lines(text):
        c = classify(ln.split()[0].split(",")[0])
        if c and c[0] == "ip":
            out.append(c[1])
    return out


def parse_hostfile(text: str) -> list[str]:
    """Format « 127.0.0.1<tab>domaine » (URLhaus) ; lignes invalides ignorées."""
    out = []
    for ln in _data_lines(text):
        parts = ln.split()
        c = classify(parts[-1]) if parts else None
        if c and c[0] == "domain":
            out.append(c[1])
    return out


def parse_hashes(text: str) -> list[str]:
    out = []
    for ln in _data_lines(text):
        c = classify(ln.split()[0])
        if c and c[0] == "hash":
            out.append(c[1])
    return out


def parse_drop(text: str) -> list[str]:
    """Spamhaus DROP (JSON ligne par ligne) : {"cidr": "1.10.16.0/20", …}."""
    out = []
    for ln in text.splitlines():
        try:
            cidr = json.loads(ln).get("cidr")
        except (json.JSONDecodeError, AttributeError):
            continue
        if isinstance(cidr, str) and "/" in cidr:
            out.append(cidr)
    return out


def parse_kev(text: str) -> list[dict]:
    """Catalogue CISA KEV : on garde les champs utiles à la fiche de vulnérabilité."""
    keep = ("cveID", "vendorProject", "product", "vulnerabilityName", "dateAdded", "shortDescription", "requiredAction", "dueDate", "knownRansomwareCampaignUse")
    data = json.loads(text)
    return [{k: v.get(k) for k in keep} for v in data.get("vulnerabilities", []) if isinstance(v, dict) and v.get("cveID")]


@dataclass(frozen=True)
class Feed:
    id: str
    name: str
    url: str
    kind: str  # ip | cidr | domain | hash | kev
    verdict: str  # ce que signifie « être dans la liste » : malicious | suspicious | reference
    license: str
    homepage: str
    description: str
    parser: Callable[[str], list]


FEEDS: tuple[Feed, ...] = (
    Feed("feodo", "abuse.ch Feodo Tracker", "https://feodotracker.abuse.ch/downloads/ipblocklist.txt", "ip", "malicious", "CC0", "https://feodotracker.abuse.ch/", "Serveurs de commande (C2) de botnets actifs.", parse_ips),
    Feed("urlhaus", "abuse.ch URLhaus", "https://urlhaus.abuse.ch/downloads/hostfile/", "domain", "malicious", "CC0", "https://urlhaus.abuse.ch/", "Domaines distribuant des logiciels malveillants.", parse_hostfile),
    Feed("bazaar", "abuse.ch MalwareBazaar", "https://bazaar.abuse.ch/export/txt/sha256/recent/", "hash", "malicious", "CC0", "https://bazaar.abuse.ch/", "Empreintes SHA-256 de malwares récents.", parse_hashes),
    Feed("drop", "Spamhaus DROP", "https://www.spamhaus.org/drop/drop_v4.json", "cidr", "malicious", "Spamhaus DROP (usage libre)", "https://www.spamhaus.org/blocklists/do-not-route-or-peer/", "Réseaux détournés ou contrôlés par des cybercriminels.", parse_drop),
    Feed("tor", "Tor : nœuds de sortie", "https://check.torproject.org/torbulkexitlist", "ip", "suspicious", "Tor Project (public)", "https://metrics.torproject.org/", "Trafic anonymisé : légitime ou non, à connaître.", parse_ips),
    Feed("kev", "CISA KEV", "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json", "kev", "reference", "Domaine public (CISA)", "https://www.cisa.gov/known-exploited-vulnerabilities-catalog", "Vulnérabilités activement exploitées (sert à l'onglet Vulnérabilités).", parse_kev),
)
BY_ID = {f.id: f for f in FEEDS}


# ─────────────────────────────── stockage
def _dir() -> Path:
    d = Path(settings.intel_dir) / "feeds"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _write_atomic(path: Path, payload) -> None:
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, path)


def load_state() -> dict:
    try:
        return json.loads((_dir() / "state.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}


def _save_state(state: dict) -> None:
    _write_atomic(_dir() / "state.json", state)


def load_entries(feed_id: str) -> list:
    try:
        return json.loads((_dir() / f"{feed_id}.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []


def is_enabled(feed_id: str, state: dict | None = None) -> bool:
    return (state if state is not None else load_state()).get(feed_id, {}).get("enabled", True)


# ─────────────────────────────── index (reconstruit après chaque rafraîchissement)
_index: FeedIndex | None = None
_index_version = -1
_version = 0


def index() -> FeedIndex:
    global _index, _index_version
    if _index is None or _index_version != _version:
        state = load_state()
        _index = FeedIndex.build({f.id: (f.kind, load_entries(f.id)) for f in FEEDS if f.kind != "kev" and is_enabled(f.id, state)})
        _index_version = _version
    return _index


# ─────────────────────────────── téléchargement
Fetch = Callable[[str], Awaitable[str]]


async def http_fetch(url: str) -> str:
    """GET HTTPS avec plafond de taille (lecture en flux)."""
    if not url.startswith("https://"):
        raise ValueError("Seules les URL HTTPS du registre sont autorisées.")
    chunks, total = [], 0
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0), verify=CA_BUNDLE, headers={"User-Agent": USER_AGENT}, follow_redirects=True) as client:
        async with client.stream("GET", url) as res:
            res.raise_for_status()
            async for chunk in res.aiter_bytes():
                total += len(chunk)
                if total > MAX_BYTES:
                    raise ValueError("Liste anormalement volumineuse : téléchargement abandonné.")
                chunks.append(chunk)
    return b"".join(chunks).decode("utf-8", "replace")


async def refresh(feed_ids: list[str] | None = None, fetch: Fetch = http_fetch) -> dict:
    """Met à jour les listes (toutes les actives, ou celles demandées). Renvoie l'état."""
    global _version
    state = load_state()
    for feed in FEEDS:
        if feed_ids is not None and feed.id not in feed_ids:
            continue
        entry = state.setdefault(feed.id, {"enabled": True})
        if not entry.get("enabled", True):
            continue
        try:
            text = await fetch(feed.url)
            parsed = feed.parser(text)
            if not parsed:
                raise ValueError("liste vide ou format inattendu")
            _write_atomic(_dir() / f"{feed.id}.json", parsed)
            entry.update({"updated": datetime.now(timezone.utc).isoformat(), "count": len(parsed), "bytes": len(text), "error": None})
        except Exception as exc:  # noqa: BLE001 - une liste en échec garde sa dernière version valide
            log.warning("liste %s : mise à jour impossible (%s)", feed.id, exc)
            entry["error"] = "Mise à jour impossible (réseau ou format) ; dernière version conservée."
            entry["error_at"] = datetime.now(timezone.utc).isoformat()
    _save_state(state)
    _version += 1
    return state


def set_enabled(feed_id: str, enabled: bool, actor: str) -> dict:
    global _version
    state = load_state()
    state.setdefault(feed_id, {})["enabled"] = enabled
    _save_state(state)
    _version += 1
    audit.info("threatintel.feed actor=%s feed=%s enabled=%s", actor, feed_id, enabled)
    return state


def stale(state: dict, now: datetime | None = None) -> bool:
    """Vrai si une liste active n'a jamais été téléchargée ou date de plus de 12 h."""
    now = now or datetime.now(timezone.utc)
    for feed in FEEDS:
        entry = state.get(feed.id, {})
        if not entry.get("enabled", True):
            continue
        updated = entry.get("updated")
        if not updated or now - datetime.fromisoformat(updated) > REFRESH_EVERY:
            return True
    return False


async def run_forever() -> None:
    """Tâche de fond : rafraîchit au démarrage si besoin, puis toutes les 12 h."""
    while True:
        try:
            if stale(load_state()):
                await refresh()
        except Exception:
            log.exception("rafraîchissement des listes de renseignement")
        await asyncio.sleep(REFRESH_EVERY.total_seconds() / 12)  # contrôle horaire, téléchargement si > 12 h
