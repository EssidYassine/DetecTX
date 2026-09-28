"""Posture de sécurité du poste en 5 piliers, chacun fondé sur une source réelle.

    Menaces     (35) dossiers d'alertes OUVERTS (un dossier ×5 compte une fois ; les closes, jamais)
    Exposition  (20) ports joignables depuis le réseau, d'après le pare-feu Windows
    Défense     (20) antivirus actif et à jour (Centre de sécurité), pare-feu actif
    Visibilité  (15) santé de la collecte (journaux lus, Sysmon)
    Santé       (10) disque, mémoire, processeur

Score global = moyenne pondérée des piliers connus, PLAFONNÉE par le pire pilier : un pilier
rouge interdit « sous contrôle ». Chaque constat cite sa source et, quand c'est possible, la
page où agir. `evaluate()` est pure (testée sans Windows) ; `collect()` rassemble les sources.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.alerts import AlertCase
from app.schemas.posture import Finding, Pillar, Posture, Tone
from app.services.security_center import Defense

log = logging.getLogger(__name__)

LEVEL_RANK = {"ok": 0, "low": 1, "medium": 2, "high": 3, "critical": 4}
VERDICT = {"ok": "Sous contrôle", "warn": "À surveiller", "critical": "Action requise", "unknown": "Posture inconnue"}
LABELS = {"threats": "Menaces", "exposure": "Exposition", "defense": "Défense", "visibility": "Visibilité", "health": "Santé"}
WEIGHTS = {"threats": 35, "exposure": 20, "defense": 20, "visibility": 15, "health": 10}
HREF = {
    "threats": "/dashboard/alerts",
    "exposure": "/dashboard/machines?vue=ports",
    "defense": "/dashboard/machines?vue=ports",
    "visibility": "/dashboard/events",
    "health": "/dashboard/machines",
}
CASE_PENALTY = {"critical": 35, "high": 12, "medium": 4, "low": 1}
PORT_PENALTY = {"critical": 40, "high": 20, "medium": 6, "low": 2}
MAX_FINDINGS = 12


@dataclass
class Inputs:
    now: datetime
    cases: list[AlertCase] | None  # dossiers ouverts ; None = source indisponible
    exposure: dict | None  # firewall.exposure()
    defense: Defense | None  # security_center.defense()
    visibility: dict | None  # collection.assess() (via event_insights.health)
    host: dict | None  # metrics.snapshot()


def _tone(score: int, findings: list[Finding]) -> Tone:
    worst = max((LEVEL_RANK[f.level] for f in findings), default=0)
    if worst >= LEVEL_RANK["critical"] or score < 40:
        return "critical"
    if worst >= LEVEL_RANK["medium"] or score < 75:
        return "warn"
    return "ok"


def _pillar(key: str, score: int | None, headline: str, findings: list[Finding], tone: Tone | None = None) -> Pillar:
    findings = sorted(findings, key=lambda f: -LEVEL_RANK[f.level])[:MAX_FINDINGS]
    if score is None:
        tone = "unknown"
    return Pillar(
        key=key,
        label=LABELS[key],
        weight=WEIGHTS[key],
        score=score,
        tone=tone or _tone(score, findings),
        headline=headline,
        href=HREF[key],
        findings=findings,
    )


def _plural(n: int, word: str) -> str:
    return f"{n} {word}{'s' if n > 1 else ''}"


# ─────────────────────────────── piliers
def threats(cases: list[AlertCase] | None) -> Pillar:
    if cases is None:
        return _pillar("threats", None, "Dossiers d'alertes illisibles.", [])
    open_cases = [c for c in cases if c.by_status.get("new", 0) + c.by_status.get("ack", 0) > 0]
    findings = [
        Finding(
            id=f"case:{c.rule_id}",
            pillar="threats",
            level=c.severity if c.severity in CASE_PENALTY else "low",
            title=f"« {c.rule_title} »" + (f" ×{c.count}" if c.count > 1 else ""),
            detail=c.tactic_fr or "Tactique non classée",
            source=f"Moteur de détection · règle {c.rule_id}" + (f" · {c.mitre}" if c.mitre else ""),
            href=f"/dashboard/alerts?case={c.rule_id}",
            action="Ouvrir le dossier",
            at=c.last_seen,
        )
        for c in open_cases
    ]
    score = max(0, 100 - sum(CASE_PENALTY.get(c.severity, 1) for c in open_cases))
    if not open_cases:
        return _pillar("threats", 100, "Aucun dossier d'alertes ouvert.", [])
    by = {s: sum(1 for c in open_cases if c.severity == s) for s in CASE_PENALTY}
    worst = next((f"{_plural(n, s_fr)}" for s, s_fr in (("critical", "critique"), ("high", "élevé")) if (n := by[s])), None)
    headline = _plural(len(open_cases), "dossier") + " ouvert" + ("s" if len(open_cases) > 1 else "") + (f", dont {worst}" if worst else "")
    return _pillar("threats", score, headline + ".", findings)


def exposure(exp: dict | None) -> Pillar:
    if not exp or not exp.get("available"):
        return _pillar("exposure", None, (exp or {}).get("error") or "État du pare-feu illisible.", [])
    active = exp["profiles"]["active"]
    seen: set[tuple] = set()
    findings: list[Finding] = []
    penalty = 0
    for p in exp["ports"]:
        level = p["risk"]["level"]
        key = (p["proto"], p["port"])
        if p["verdict"] != "open" or level not in PORT_PENALTY or key in seen:
            continue
        seen.add(key)
        penalty += PORT_PENALTY[level]
        findings.append(
            Finding(
                id=f"port:{p['proto']}:{p['port']}",
                pillar="exposure",
                level=level,
                title=f"Port {p['proto'].upper()} {p['port']} joignable · {p['risk']['service']}",
                detail=p["risk"]["why"],
                source=f"Pare-feu Windows · {p['reason']}",
                href="/dashboard/machines?vue=ports",
                action="Voir le port",
            )
        )
    profile = " / ".join(active) or "inconnu"
    if not findings:
        return _pillar("exposure", 100, f"Aucun port à risque joignable (profil {profile}).", [])
    return _pillar("exposure", max(0, 100 - penalty), f"{_plural(len(findings), 'port')} à risque joignable{'s' if len(findings) > 1 else ''} depuis le réseau (profil {profile}).", findings)


def defense(state: Defense | None, exp: dict | None) -> Pillar:
    if state is None or not state.available:
        return _pillar("defense", None, (state.error if state else None) or "Centre de sécurité Windows illisible.", [])
    findings: list[Finding] = []
    score = 100
    avs = [p for p in state.products if p.kind == "antivirus"]
    active = [p for p in avs if p.active]
    source = "Centre de sécurité Windows"
    if not active:
        score = 0
        findings.append(Finding(id="av:none", pillar="defense", level="critical", title="Aucun antivirus actif", detail="Ouvrez « Sécurité Windows » pour réactiver la protection en temps réel.", source=source))
    else:
        for p in active:
            if p.up_to_date:
                findings.append(Finding(id=f"av:{p.name}", pillar="defense", level="ok", title=f"{p.name} actif, signatures à jour", source=source))
            else:
                score = min(score, 50)
                findings.append(Finding(id=f"av:{p.name}", pillar="defense", level="high", title=f"{p.name} : signatures périmées", detail="Lancez une mise à jour de l'antivirus.", source=source))
        for p in avs:
            if not p.active and "defender" in p.name.lower():
                findings.append(Finding(id="av:defender-passive", pillar="defense", level="ok", title="Microsoft Defender en mode passif", detail=f"Normal : {active[0].name} assure la protection.", source=source))
    if exp and exp.get("available"):
        states = exp["profiles"]["states"]
        for name in exp["profiles"]["active"]:
            if states.get(name, {}).get("enabled") is False:
                score = max(0, score - 50)
                findings.append(
                    Finding(id=f"fw:{name}", pillar="defense", level="critical", title=f"Pare-feu désactivé sur le profil {name}", detail="Tous les ports du poste sont joignables.", source="Pare-feu Windows", href="/dashboard/machines?vue=ports", action="Voir le pare-feu")
                )
            else:
                findings.append(Finding(id=f"fw:{name}", pillar="defense", level="ok", title=f"Pare-feu actif (profil {name})", source="Pare-feu Windows"))
    bad = [f for f in findings if f.level != "ok"]
    headline = bad[0].title + "." if bad else "Antivirus actif et à jour, pare-feu actif."
    return _pillar("defense", score, headline, findings)


def visibility(health: dict | None) -> Pillar:
    if health is None:
        return _pillar("visibility", None, "Santé de la collecte illisible.", [])
    href, action = "/dashboard/events", "Compléter la collecte"
    if health.get("status") == "down":
        f = Finding(id="collect:down", pillar="visibility", level="critical", title="La collecte est arrêtée", detail=health.get("summary"), source="Santé de la collecte", href=href, action="Rétablir la collecte")
        return _pillar("visibility", 0, "Collecte arrêtée, plus rien n'est surveillé.", [f])
    findings: list[Finding] = []
    penalty = 0
    minor = 0
    for ch in health.get("channels", []):
        if "Sysmon" in (ch.get("channel") or ""):
            continue  # couvert par le constat Sysmon ci-dessous (pas de double pénalité)
        if ch.get("status") == "missing" and ch.get("channel") == "Security":
            penalty += 25
            findings.append(Finding(id="collect:security", pillar="visibility", level="medium", title="Journal Sécurité non lu", detail=ch.get("hint") or "Connexions et comptes non tracés.", source="Santé de la collecte", href=href, action=action))
        elif ch.get("status") in ("missing", "stale"):
            minor += 5
            findings.append(Finding(id=f"collect:{ch.get('channel')}", pillar="visibility", level="low", title=f"Journal {ch.get('label', ch.get('channel'))} {'absent' if ch.get('status') == 'missing' else 'en retard'}", detail=ch.get("hint"), source="Santé de la collecte", href=href, action=action))
    penalty += min(minor, 20)
    sysmon = health.get("sysmon") or {}
    if not sysmon.get("running"):
        penalty += 20
        findings.append(
            Finding(id="collect:sysmon", pillar="visibility", level="medium", title="Sysmon " + ("arrêté" if sysmon.get("installed") else "non installé"), detail="Processus, connexions et registre ne sont pas tracés en détail.", source="Santé de la collecte", href=href, action=action)
        )
    alive = [c for c in health.get("collectors", []) if c.get("alive")]
    if alive:
        findings.append(Finding(id="collect:alive", pillar="visibility", level="ok", title=f"{_plural(len(alive), 'collecteur')} actif{'s' if len(alive) > 1 else ''}", source="Santé de la collecte"))
    score = max(0, 100 - penalty)
    gaps = [f for f in findings if f.level != "ok"]
    headline = "Collecte complète." if not gaps else f"Collecte partielle : {', '.join(f.title[0].lower() + f.title[1:] for f in gaps[:2])}."
    tone: Tone | None = "ok" if score >= 90 and not gaps else None
    return _pillar("visibility", score, headline, findings, tone)


def health(host: dict | None) -> Pillar:
    if host is None:
        return _pillar("health", None, "Ressources du poste illisibles.", [])
    href = "/dashboard/machines"
    findings: list[Finding] = []
    penalty = 0
    for d in host.get("disks", []):
        pct = d.get("percent", 0)
        if pct >= 95:
            penalty += 60
            findings.append(Finding(id=f"disk:{d['mount']}", pillar="health", level="critical", title=f"Disque {d['mount']} plein à {pct:.0f} %", detail="Journaux et mises à jour peuvent échouer.", source="Ressources du poste", href=href, action="Voir le stockage"))
        elif pct >= 85:
            penalty += 25
            findings.append(Finding(id=f"disk:{d['mount']}", pillar="health", level="medium", title=f"Disque {d['mount']} rempli à {pct:.0f} %", detail="Prévoir de libérer de l'espace.", source="Ressources du poste", href=href, action="Voir le stockage"))
    if host.get("ram_percent", 0) >= 90:
        penalty += 20
        findings.append(Finding(id="ram", pillar="health", level="medium", title=f"Mémoire saturée ({host['ram_percent']:.0f} %)", source="Ressources du poste", href=href, action="Voir les processus"))
    if host.get("cpu_percent", 0) >= 90:
        penalty += 10
        findings.append(Finding(id="cpu", pillar="health", level="low", title=f"Processeur très chargé ({host['cpu_percent']:.0f} %)", source="Ressources du poste", href=href, action="Voir les processus"))
    headline = "Ressources confortables." if not findings else findings[0].title + "."
    return _pillar("health", max(0, 100 - penalty), headline, findings)


# ─────────────────────────────── synthèse
def _summary(pillars: list[Pillar], tone: Tone) -> str:
    known = [p for p in pillars if p.tone != "unknown"]
    if not known:
        return "Aucune source n'a pu être lue : posture inconnue."
    if tone == "ok":
        return "Tout est en ordre : " + ", ".join(p.label.lower() for p in known) + " sous contrôle."
    parts = [f"{p.label} : {p.headline[0].lower()}{p.headline[1:]}" for p in known if p.tone == "critical"]
    warn = [p.label.lower() for p in known if p.tone == "warn"]
    good = [p.label.lower() for p in known if p.tone == "ok"]
    if warn:
        parts.append("À surveiller : " + ", ".join(warn) + ".")
    if good:
        parts.append("Solide : " + ", ".join(good) + ".")
    return " ".join(parts)


def _priorities(pillars: list[Pillar], limit: int = 6) -> list[Finding]:
    """Les 2 constats les plus graves de chaque pilier, puis tri global : on voit toutes les
    familles de problèmes, pas seulement 6 dossiers d'alertes."""
    picked = [f for p in pillars for f in [f for f in p.findings if f.level != "ok"][:2]]
    return sorted(picked, key=lambda f: (-LEVEL_RANK[f.level], -WEIGHTS[f.pillar]))[:limit]


def evaluate(inputs: Inputs) -> Posture:
    pillars = [
        threats(inputs.cases),
        exposure(inputs.exposure),
        defense(inputs.defense, inputs.exposure),
        visibility(inputs.visibility),
        health(inputs.host),
    ]
    known = [p for p in pillars if p.score is not None]
    if not known:
        score, tone = None, "unknown"
    else:
        score = round(sum(p.score * p.weight for p in known) / sum(p.weight for p in known))
        if any(p.tone == "critical" for p in known):
            score = min(score, 39)
        elif any(p.tone == "warn" for p in known):
            score = min(score, 74)
        tone = "critical" if score < 40 else "warn" if score < 75 else "ok"
    return Posture(
        score=score,
        tone=tone,
        verdict=VERDICT[tone],
        summary=_summary(pillars, tone),
        pillars=pillars,
        priorities=_priorities(pillars),
        generated_at=inputs.now,
    )


# ─────────────────────────────── collecte des sources
async def _guard(label: str, coro):
    try:
        return await coro
    except Exception as exc:  # noqa: BLE001 - une source en panne donne un pilier « inconnu », pas une page cassée
        log.warning("posture : source %s indisponible (%s)", label, exc)
        return None


async def collect(session: AsyncSession) -> Posture:
    from app.services import alerts as alerts_svc
    from app.services import event_insights, firewall, metrics, security_center

    page = await _guard("alertes", alerts_svc.list_cases(session, status="open"))
    exp, dfn, vis, host = await asyncio.gather(
        _guard("pare-feu", asyncio.to_thread(firewall.exposure)),
        _guard("centre de sécurité", asyncio.to_thread(security_center.defense)),
        _guard("collecte", event_insights.health()),
        _guard("ressources", asyncio.to_thread(metrics.snapshot)),
    )
    return evaluate(Inputs(now=datetime.now(timezone.utc), cases=page.cases if page else None, exposure=exp, defense=dfn, visibility=vis, host=host))
