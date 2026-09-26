"""Import et évaluation des règles SigmaHQ.

- Charge les règles YAML du référentiel officiel (dossier _sigma_src/rules/windows).
- Les évalue en Python contre les événements collectés (champs structurés + message).
  Convient au mono-hôte (volume d'événements faible), backend SQL comme OpenSearch.

Sous-ensemble Sigma supporté (couvre la grande majorité des règles Windows) :
sélections map / liste-de-maps / keywords ; modificateurs contains, startswith,
endswith, re, all, cased, windash ; wildcards * ? ; conditions and/or/not,
parenthèses, "N of ...", "all of ...", "1 of ...".
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from functools import lru_cache
from pathlib import Path

import yaml

_SIGMA_DIR = Path(__file__).parent / "_sigma_src" / "rules" / "windows"

_LEVEL_TO_SEVERITY = {
    "informational": "low",
    "low": "low",
    "medium": "medium",
    "high": "high",
    "critical": "critical",
}

# category Sigma -> (mot-clé de canal, event_ids acceptés | None = tous)
_CATEGORY_MAP: dict[str, tuple[str, set[int] | None]] = {
    "process_creation": ("Sysmon", {1}),
    "registry_set": ("Sysmon", {13}),
    "registry_add": ("Sysmon", {12}),
    "registry_delete": ("Sysmon", {12}),
    "registry_event": ("Sysmon", {12, 13, 14}),
    "network_connection": ("Sysmon", {3}),
    "dns_query": ("Sysmon", {22}),
    "image_load": ("Sysmon", {7}),
    "driver_load": ("Sysmon", {6}),
    "file_event": ("Sysmon", {11}),
    "file_change": ("Sysmon", {2}),
    "file_delete": ("Sysmon", {23, 26}),
    "create_remote_thread": ("Sysmon", {8}),
    "create_stream_hash": ("Sysmon", {15}),
    "process_access": ("Sysmon", {10}),
    "pipe_created": ("Sysmon", {17, 18}),
    "wmi_event": ("Sysmon", {19, 20, 21}),
    "raw_access_thread": ("Sysmon", {9}),
    "process_tampering": ("Sysmon", {25}),
    "sysmon_status": ("Sysmon", {4, 16}),
    "dns_query": ("Sysmon", {22}),
    "ps_script": ("PowerShell", {4104}),
    "ps_module": ("PowerShell", {4103}),
    "ps_classic_start": ("PowerShell", None),
}

# Sentinelle : canal impossible -> la règle ne s'applique à aucun événement.
_INERT = "\x00none"

_SERVICE_MAP: dict[str, str] = {
    "security": "Security",
    "sysmon": "Sysmon",
    "powershell": "PowerShell",
    "powershell-classic": "PowerShell",
    "system": "System",
    "application": "Application",
}


@dataclass
class SigmaRule:
    id: str
    title: str
    severity: str
    mitre: str | None
    category: str | None
    service: str | None
    detection: dict
    condition: str
    channel_hint: str | None = field(default=None)
    event_ids: set[int] | None = field(default=None)

    def applies_to(self, event: dict) -> bool:
        ch = event.get("channel") or ""
        if self.channel_hint and self.channel_hint not in ch:
            return False
        if self.event_ids is not None and event.get("event_id") not in self.event_ids:
            return False
        return True


def _extract_mitre(tags: list) -> str | None:
    for t in tags or []:
        m = re.match(r"attack\.(t\d{4}(?:\.\d{3})?)", str(t), re.IGNORECASE)
        if m:
            return m.group(1).upper()
    return None


@lru_cache
def load_sigma_rules() -> list[SigmaRule]:
    rules: list[SigmaRule] = []
    if not _SIGMA_DIR.exists():
        return rules
    for path in _SIGMA_DIR.rglob("*.yml"):
        try:
            docs = list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
        except Exception:
            continue
        doc = next((d for d in docs if isinstance(d, dict) and "detection" in d and "logsource" in d), None)
        if not doc:
            continue
        if doc.get("status") in ("deprecated", "unsupported"):
            continue
        det = doc["detection"]
        cond = det.get("condition")
        if not isinstance(cond, str):  # conditions multiples/correlation -> non supporté
            continue

        ls = doc.get("logsource") or {}
        category = ls.get("category")
        service = ls.get("service")
        channel_hint, event_ids = None, None
        if category:
            # catégorie non mappée -> inerte (télémétrie non collectée)
            channel_hint, event_ids = _CATEGORY_MAP.get(category, (_INERT, set()))
        elif service:
            channel_hint = _SERVICE_MAP.get(service, _INERT)
            if channel_hint is _INERT:
                event_ids = set()

        rules.append(
            SigmaRule(
                id=str(doc.get("id", path.stem)),
                title=doc.get("title", path.stem),
                severity=_LEVEL_TO_SEVERITY.get(doc.get("level", "medium"), "medium"),
                mitre=_extract_mitre(doc.get("tags", [])),
                category=category,
                service=service,
                detection=det,
                condition=cond,
                channel_hint=channel_hint,
                event_ids=event_ids,
            )
        )
    return rules


# ─────────────────────────── Évaluation ───────────────────────────
def _event_haystack(event: dict) -> str:
    parts = [str(v) for v in (event.get("fields") or {}).values()]
    if event.get("message"):
        parts.append(str(event["message"]))
    return "\n".join(parts).lower()


def _get_field(event: dict, name: str):
    fields = event.get("fields") or {}
    if name in fields:
        return fields[name]
    low = name.lower()
    for k, v in fields.items():
        if k.lower() == low:
            return v
    if low in ("eventid", "event_id"):
        return event.get("event_id")
    return None


def _match_scalar(field_val, expected: str, mods: list[str]) -> bool:
    if field_val is None:
        return False
    fv = str(field_val)
    exp = str(expected)
    if "windash" in mods:
        fv = fv.replace("–", "-").replace("—", "-").replace("/", "-")
        exp = exp.replace("/", "-")
    cased = "cased" in mods
    if not cased:
        fv, exp = fv.lower(), exp.lower()
    if "re" in mods:
        try:
            return re.search(exp, fv, 0 if cased else re.IGNORECASE) is not None
        except re.error:
            return False
    if "contains" in mods:
        return exp in fv
    if "startswith" in mods:
        return fv.startswith(exp)
    if "endswith" in mods:
        return fv.endswith(exp)
    # défaut : égalité, avec support wildcard * ?
    if "*" in exp or "?" in exp:
        rx = "^" + re.escape(exp).replace(r"\*", ".*").replace(r"\?", ".") + "$"
        return re.match(rx, fv) is not None
    return fv == exp


def _match_item(event: dict, key: str, value, keywords_mode: bool) -> bool:
    # keywords : liste de chaînes cherchées dans tout l'événement
    if keywords_mode:
        hay = _event_haystack(event)
        vals = value if isinstance(value, list) else [value]
        return any(str(v).lower() in hay for v in vals)

    parts = key.split("|")
    field_name = parts[0]
    mods = parts[1:]
    field_val = _get_field(event, field_name)

    if isinstance(value, list):
        results = [_match_scalar(field_val, v, mods) for v in value]
        return all(results) if "all" in mods else any(results)
    return _match_scalar(field_val, value, mods)


def _match_selection(event: dict, sel) -> bool:
    # liste de chaînes -> keywords (OR)
    if isinstance(sel, list) and all(not isinstance(x, dict) for x in sel):
        return _match_item(event, "", sel, keywords_mode=True)
    # liste de maps -> OR
    if isinstance(sel, list):
        return any(_match_selection(event, s) for s in sel)
    # map -> AND sur les champs
    if isinstance(sel, dict):
        return all(_match_item(event, k, v, keywords_mode=False) for k, v in sel.items())
    # chaîne seule -> keyword
    return _match_item(event, "", sel, keywords_mode=True)


_ALLOWED_TOKENS = {"and", "or", "not", "(", ")", "True", "False"}


def _eval_condition(cond: str, sel_bools: dict[str, bool]) -> bool:
    def repl_of(m: re.Match) -> str:
        qty, pat = m.group("qty"), m.group("pat")
        if pat == "them":
            names = list(sel_bools)
        else:
            rx = "^" + pat.replace("*", ".*") + "$"
            names = [n for n in sel_bools if re.match(rx, n)]
        vals = [sel_bools.get(n, False) for n in names]
        if not names:
            return "False"
        if qty == "all":
            return "True" if all(vals) else "False"
        if qty in ("1", "any"):
            return "True" if any(vals) else "False"
        try:
            return "True" if sum(vals) >= int(qty) else "False"
        except ValueError:
            return "False"

    expr = re.sub(r"(?P<qty>all|any|\d+) of (?P<pat>them|[A-Za-z0-9_*]+)", repl_of, cond)

    def repl_name(m: re.Match) -> str:
        n = m.group(0)
        if n in ("and", "or", "not"):
            return n
        return "True" if sel_bools.get(n, False) else "False"

    expr = re.sub(r"[A-Za-z_][A-Za-z0-9_]*", repl_name, expr)

    if any(tok not in _ALLOWED_TOKENS for tok in re.findall(r"[A-Za-z]+|\(|\)", expr)):
        return False
    try:
        return bool(eval(expr, {"__builtins__": {}}, {}))  # tokens validés ci-dessus
    except Exception:
        return False


def rule_matches(rule: SigmaRule, event: dict) -> bool:
    sel_bools: dict[str, bool] = {}
    for name, sel in rule.detection.items():
        if name == "condition":
            continue
        try:
            sel_bools[name] = _match_selection(event, sel)
        except Exception:
            sel_bools[name] = False
    return _eval_condition(rule.condition, sel_bools)


# ─────────────────────────── Détection ───────────────────────────
_SEV_SCORE = {"critical": 90, "high": 70, "medium": 45, "low": 20}


def _parse_ts(value: object) -> datetime:
    if isinstance(value, datetime):
        return value
    if not value:
        return datetime.now(timezone.utc)
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return datetime.now(timezone.utc)


def detect_over_events(events: list[dict]) -> list[dict]:
    """Évalue toutes les règles Sigma applicables sur chaque événement (synchrone)."""
    rules = load_sigma_rules()
    out: list[dict] = []
    for event in events:
        for rule in rules:
            if not rule.applies_to(event):
                continue
            if not rule_matches(rule, event):
                continue
            rid = event.get("record_id")
            anchor = rid if rid is not None else abs(hash(event.get("message") or ""))
            out.append(
                {
                    "dedup_key": f"sigma:{rule.id}:{event.get('channel')}:{anchor}",
                    "rule_id": rule.id[:120],
                    "rule_title": (rule.title or rule.id)[:255],
                    "severity": rule.severity,
                    "risk_score": _SEV_SCORE.get(rule.severity, 30),
                    "mitre": rule.mitre,
                    "channel": event.get("channel"),
                    "event_id": event.get("event_id"),
                    "event_record_id": rid,
                    "event_timestamp": _parse_ts(event.get("timestamp")),
                    "message": (event.get("message") or rule.title or "")[:2000],
                }
            )
    return out
