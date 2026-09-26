"""Explication d'alerte et assistant SOC.

Base déterministe (MITRE embarqué + contexte de l'alerte) toujours disponible ;
enrichissement par LLM quand un provider est configuré.
"""

from app.ai import llm
from app.ai.mitre import technique_info
from app.models.alert import Alert
from app.schemas.ai import ExplanationOut

_SYSTEM = (
    "Tu es un analyste SOC senior. Tu expliques une alerte de sécurité Windows de façon "
    "concise, factuelle et actionnable, en français. Chaque affirmation doit se fonder sur "
    "les données fournies — n'invente rien."
)


def _mitre_url(mid: str) -> str:
    if not mid or mid == "N/A":
        return "https://attack.mitre.org/"
    parts = mid.split(".")
    url = f"https://attack.mitre.org/techniques/{parts[0]}/"
    if len(parts) > 1:
        url += f"{parts[1]}/"
    return url


async def explain_alert(alert: Alert) -> ExplanationOut:
    info = technique_info(alert.mitre)
    msg = (alert.message or "").strip()
    cause = (
        f"Déclenchée par la règle « {alert.rule_title} » sur le canal "
        f"{alert.channel or 'inconnu'} (EventID {alert.event_id if alert.event_id is not None else '—'}). "
        f"Élément déclencheur : {msg[:400] or 'n/a'}"
    )

    out = ExplanationOut(
        alert_id=alert.id,
        rule_title=alert.rule_title,
        severity=alert.severity,
        mitre_id=info["id"],
        mitre_name=info["name"],
        tactic=info["tactic_fr"],
        description=info["desc"],
        cause=cause,
        impact=info["impact"],
        remediation=list(info["remediation"]),
        commands=list(info["commands"]),
        references=[_mitre_url(info["id"])],
        source="builtin",
    )

    prompt = (
        f"Alerte : {alert.rule_title}\n"
        f"Sévérité : {alert.severity} (score {alert.risk_score})\n"
        f"Technique MITRE : {info['id']} — {info['name']} ({info['tactic_fr']})\n"
        f"Canal : {alert.channel} | EventID : {alert.event_id}\n"
        f"Détail de l'événement :\n{msg[:1500]}\n\n"
        "Rédige un court paragraphe (4-6 phrases) expliquant à un analyste : ce qui s'est passé, "
        "pourquoi c'est suspect, et la première action de triage recommandée."
    )
    narrative = await llm.complete(_SYSTEM, prompt)
    if narrative:
        out.ai_narrative = narrative.strip()
        out.source = llm.provider_name()
    return out


async def answer_question(question: str, context: str) -> tuple[str, str]:
    """Assistant SOC. Retourne (réponse, provider)."""
    prompt = (
        "Contexte (alertes/événements récents de l'hôte) :\n"
        f"{context}\n\n"
        f"Question de l'analyste : {question}\n\n"
        "Réponds de façon concise et actionnable, en te fondant uniquement sur le contexte."
    )
    answer = await llm.complete(_SYSTEM, prompt)
    if answer:
        return answer.strip(), llm.provider_name()

    fallback = (
        "Aucun modèle d'IA n'est configuré (définis LLM_PROVIDER + clé, ou lance Ollama). "
        "Voici néanmoins le contexte pertinent que j'ai rassemblé :\n\n" + context
    )
    return fallback, "builtin"
