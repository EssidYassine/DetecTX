"""Moteur de détection DeTecTX.

Charge des règles au format Sigma-like (YAML) et interroge le service events
(OpenSearch ou SQL local) pour produire des candidats d'alerte avec score de
risque + technique MITRE.
"""

from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel, Field

from app.services import events as svc

_RULES_DIR = Path(__file__).parent / "rules"
_SEVERITY_SCORE = {"critical": 90, "high": 70, "medium": 45, "low": 20}


class RuleMatch(BaseModel):
    channel: str | None = None
    event_id: int | None = None
    keywords: list[str] = Field(default_factory=list)


class RuleThreshold(BaseModel):
    count: int
    minutes: int


class Rule(BaseModel):
    id: str
    title: str
    description: str | None = None
    level: str
    mitre: str | None = None
    match: RuleMatch = Field(default_factory=RuleMatch)
    threshold: RuleThreshold | None = None

    @property
    def risk_score(self) -> int:
        return _SEVERITY_SCORE.get(self.level, 30)


@lru_cache
def load_rules() -> list[Rule]:
    rules: list[Rule] = []
    for path in sorted(_RULES_DIR.glob("*.yml")):
        rules.append(Rule(**yaml.safe_load(path.read_text(encoding="utf-8"))))
    return rules


def _parse_ts(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def _candidate(rule: Rule, *, dedup_key: str, event: dict | None, message: str,
               event_ts: datetime) -> dict:
    e = event or {}
    return {
        "dedup_key": dedup_key,
        "rule_id": rule.id,
        "rule_title": rule.title,
        "severity": rule.level,
        "risk_score": rule.risk_score,
        "mitre": rule.mitre,
        "channel": e.get("channel", rule.match.channel),
        "event_id": e.get("event_id", rule.match.event_id),
        "event_record_id": e.get("record_id"),
        "event_timestamp": event_ts,
        "message": message,
    }


async def _run_match_rule(rule: Rule) -> list[dict]:
    events = await svc.query_events(
        channel=rule.match.channel,
        event_id=rule.match.event_id,
        keywords=rule.match.keywords,
        minutes=None,
        limit=200,
    )
    candidates = []
    for e in events:
        rid = e.get("record_id")
        anchor = rid if rid is not None else abs(hash((e.get("channel"), e.get("message"))))
        candidates.append(
            _candidate(
                rule,
                dedup_key=f"{rule.id}:{e.get('channel')}:{anchor}",
                event=e,
                message=e.get("message") or rule.title,
                event_ts=_parse_ts(e.get("timestamp")),
            )
        )
    return candidates


async def _run_threshold_rule(rule: Rule) -> list[dict]:
    assert rule.threshold is not None
    count = await svc.count_events(
        channel=rule.match.channel,
        event_id=rule.match.event_id,
        keywords=rule.match.keywords,
        minutes=rule.threshold.minutes,
    )
    if count < rule.threshold.count:
        return []

    now = datetime.now(timezone.utc)
    bucket = int(now.timestamp()) // (rule.threshold.minutes * 60)
    return [
        _candidate(
            rule,
            dedup_key=f"{rule.id}:bucket:{bucket}",
            event=None,
            message=f"{count} occurrences en {rule.threshold.minutes} min (seuil {rule.threshold.count})",
            event_ts=now,
        )
    ]


async def detect(extra_rules: list["Rule"] | None = None) -> list[dict]:
    """Exécute les règles YAML + les règles supplémentaires (custom) fournies."""
    candidates: list[dict] = []
    for rule in load_rules() + (extra_rules or []):
        if rule.threshold is not None:
            candidates.extend(await _run_threshold_rule(rule))
        else:
            candidates.extend(await _run_match_rule(rule))
    return candidates
