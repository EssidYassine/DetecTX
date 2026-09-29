"""Couverture MITRE ATT&CK : ce que DeTecTX détecte RÉELLEMENT, et non en théorie.

Une règle ne protège que si sa source de données est collectée : sans Sysmon, les 1 864 règles
Sigma « process_creation, registry… » ne peuvent jamais se déclencher. Pour chaque technique :
    théorique = règles qui fonctionneraient si toutes les sources gérées étaient collectées
    effectif  = règles dont la source est collectée aujourd'hui
Les règles « inertes » (télémétrie que DeTecTX ne sait pas collecter) ne comptent ni l'un ni l'autre.

Données ATT&CK : app/data/attack_enterprise.json (extrait officiel, scripts/build_attack_data.py).
`coverage()` est pure (testée) ; `collect()` rassemble règles, sources et alertes.
"""

import asyncio
import json
from collections import Counter
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from sqlalchemy import case, func, select
from sqlalchemy.ext.asyncio import AsyncSession

DATA_FILE = Path(__file__).resolve().parents[1] / "data" / "attack_enterprise.json"

# Sources que l'on peut activer (simulateur) ; « any » = toute source, « inert » = jamais.
SOURCES = ("Sysmon", "Security", "PowerShell", "System", "Application", "Agent")
SOURCE_LABEL = {
    "Sysmon": "Sysmon",
    "Security": "Journal Sécurité (agent administrateur)",
    "PowerShell": "Journaux PowerShell",
    "System": "Journal Système",
    "Application": "Journal Application",
    "Agent": "Agent DeTecTX (fichiers surveillés)",
    "any": "Toute source",
    "inert": "Télémétrie non collectable",
}
SOURCE_HOWTO = {
    "Sysmon": "Installer Sysmon (PowerShell administrateur) : powershell -ExecutionPolicy Bypass -File .\\collectors\\install-sysmon.ps1",
    "Security": "Lancer l'agent en PowerShell administrateur : collectors\\agent\\detectx-agent.ps1",
    "Agent": "Lancer l'agent DeTecTX (surveillance de fichiers) : collectors\\agent\\detectx-agent.ps1",
}


@dataclass(frozen=True)
class RuleRef:
    id: str
    title: str
    severity: str
    source: str
    origin: str  # sigma | interne | perso
    techniques: tuple[str, ...]


# ─────────────────────────────── données ATT&CK
@lru_cache
def attack_data() -> dict:
    return json.loads(DATA_FILE.read_text(encoding="utf-8"))


def tactic_order() -> list[str]:
    return [t["id"] for t in attack_data()["tactics"]]


def technique_info(tid: str) -> dict:
    """Nom, tactiques, description, lien ; une sous-technique inconnue hérite de son parent."""
    techs = attack_data()["techniques"]
    info = techs.get(tid) or techs.get(tid.split(".")[0]) or {}
    return {
        "name": (techs.get(tid) or {}).get("name") or (f"{info['name']} (sous-technique)" if info else None),
        "tactics": info.get("tactics", []),
        "desc": (techs.get(tid) or {}).get("desc") or info.get("desc"),
        "url": (techs.get(tid) or {}).get("url") or f"https://attack.mitre.org/techniques/{tid.replace('.', '/')}",
    }


def source_of_channel(channel: str | None) -> str:
    """Journal d'une règle interne ou personnalisée -> source de données."""
    if not channel:
        return "any"
    c = channel.lower()
    for key, source in (("sysmon", "Sysmon"), ("powershell", "PowerShell"), ("security", "Security"), ("filemonitor", "Agent"), ("detectx", "Agent")):
        if key in c:
            return source
    if c == "system":
        return "System"
    if c == "application":
        return "Application"
    return "any"  # autre journal collecté (pare-feu, Defender…) : pas de source à activer


# ─────────────────────────────── index des règles (coûteux : construit une fois)
@lru_cache
def static_rules() -> tuple[RuleRef, ...]:
    """Règles Sigma + internes (YAML). Le chargement Sigma prend ~5 s : à appeler hors boucle."""
    from app.detection import engine, sigma

    refs = [
        RuleRef(id=r.id, title=r.title, severity=r.severity, source=r.source, origin="sigma", techniques=r.techniques)
        for r in sigma.load_sigma_rules()
        if r.techniques
    ]
    refs += [
        RuleRef(id=r.id, title=r.title, severity=r.level, source=source_of_channel(r.match.channel), origin="interne", techniques=(r.mitre.upper(),))
        for r in engine.load_rules()
        if r.mitre
    ]
    return tuple(refs)


# ─────────────────────────────── calcul pur
def available_sources(health: dict | None) -> set[str]:
    """Sources réellement collectées, d'après la santé de la collecte."""
    if not health:
        return set()
    readable = {c["channel"] for c in health.get("channels", []) if c.get("status") != "missing"}
    out = set()
    if (health.get("sysmon") or {}).get("running"):
        out.add("Sysmon")
    if "Security" in readable:
        out.add("Security")
    if readable & {"Microsoft-Windows-PowerShell/Operational", "Windows PowerShell"}:
        out.add("PowerShell")
    for ch in ("System", "Application"):
        if ch in readable:
            out.add(ch)
    if "DeTecTX-FileMonitor" in readable:
        out.add("Agent")
    return out


def _counts(rules: list[RuleRef]) -> dict[str, Counter]:
    per: dict[str, Counter] = {}
    for r in rules:
        for t in r.techniques:
            per.setdefault(t, Counter())[r.source] += 1
    return per


def effective_count(by_source: dict[str, int], available: set[str]) -> int:
    return sum(n for src, n in by_source.items() if src == "any" or src in available)


def coverage(rules: list[RuleRef], available: set[str], alerts: dict[str, tuple[int, int]]) -> dict:
    """Couverture par technique. `alerts` : technique -> (total, ouvertes)."""
    per = _counts(rules)
    order = tactic_order()
    ids = set(attack_data()["techniques"]) | set(per) | set(alerts)
    techniques = []
    for tid in sorted(ids):
        info = technique_info(tid)
        by_source = dict(per.get(tid, Counter()))
        inert = by_source.pop("inert", 0)
        tactics = [t for t in order if t in info["tactics"]] or ["unknown"]
        total, opened = alerts.get(tid, (0, 0))
        techniques.append(
            {
                "id": tid,
                "name": info["name"],
                "tactics": tactics,
                "district": tactics[0],
                "desc": info["desc"],
                "url": info["url"],
                "by_source": by_source,
                "theoretical": sum(by_source.values()),
                "effective": effective_count(by_source, available),
                "inert": inert,
                "alerts": total,
                "alerts_open": opened,
            }
        )

    rules_theoretical = sum(1 for r in rules if r.source != "inert")
    rules_effective = sum(1 for r in rules if r.source == "any" or r.source in available)
    plan = []
    for src in SOURCES:
        if src in available:
            continue
        gain_rules = sum(1 for r in rules if r.source == src)
        gain_techniques = sum(1 for t in techniques if t["effective"] == 0 and t["by_source"].get(src, 0) > 0)
        if gain_rules:
            plan.append({"source": src, "label": SOURCE_LABEL[src], "how": SOURCE_HOWTO.get(src), "rules": gain_rules, "techniques": gain_techniques})
    plan.sort(key=lambda p: (p["techniques"], p["rules"]), reverse=True)

    return {
        "attack_version": attack_data().get("attack_version"),
        "tactics": [{"id": t["id"], "name": t["name"]} for t in attack_data()["tactics"]],
        "sources": [{"id": s, "label": SOURCE_LABEL[s], "available": s in available} for s in SOURCES],
        "techniques": techniques,
        "totals": {
            "techniques": len(techniques),
            "techniques_theoretical": sum(1 for t in techniques if t["theoretical"]),
            "techniques_effective": sum(1 for t in techniques if t["effective"]),
            "techniques_observed": sum(1 for t in techniques if t["alerts"]),
            "rules_theoretical": rules_theoretical,
            "rules_effective": rules_effective,
            "rules_inert": sum(1 for r in rules if r.source == "inert"),
        },
        "plan": plan,
        "observed_uncovered": [t["id"] for t in techniques if t["alerts"] and not t["effective"]],
    }


def rules_for(rules: list[RuleRef], tid: str, available: set[str]) -> list[dict]:
    """Règles d'une technique, actives d'abord, avec la raison quand elles sont aveugles."""
    out = []
    for r in rules:
        if tid not in r.techniques:
            continue
        active = r.source == "any" or r.source in available
        reason = None if active else ("Télémétrie non collectable par DeTecTX" if r.source == "inert" else f"Nécessite : {SOURCE_LABEL.get(r.source, r.source)}")
        out.append({"id": r.id, "title": r.title, "severity": r.severity, "origin": r.origin, "source": r.source, "active": active, "reason": reason})
    rank = {"critical": 0, "high": 1, "medium": 2, "low": 3}
    return sorted(out, key=lambda x: (not x["active"], rank.get(x["severity"], 4), x["title"]))


# ─────────────────────────────── collecte
async def gather(session: AsyncSession) -> tuple[list[RuleRef], set[str], dict[str, tuple[int, int]]]:
    from app.models.alert import Alert
    from app.models.rule import CustomRule
    from app.services import event_insights

    rules = list(await asyncio.to_thread(static_rules))
    custom = (await session.scalars(select(CustomRule).where(CustomRule.enabled.is_(True), CustomRule.mitre.is_not(None)))).all()
    rules += [RuleRef(id=c.rule_id, title=c.title, severity=c.level, source=source_of_channel(c.channel), origin="perso", techniques=(c.mitre.upper(),)) for c in custom]
    try:
        health = await event_insights.health()
    except Exception:  # noqa: BLE001 - sans santé, aucune source n'est tenue pour collectée (posture prudente)
        health = None
    rows = await session.execute(
        select(Alert.mitre, func.count(), func.sum(case((Alert.status.in_(("new", "ack")), 1), else_=0))).where(Alert.mitre.is_not(None)).group_by(Alert.mitre)
    )
    alerts = {m.upper(): (n, int(o or 0)) for m, n, o in rows.all()}
    return rules, available_sources(health), alerts
