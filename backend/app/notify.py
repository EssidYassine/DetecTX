"""Notifications sortantes (Discord webhook).

N'envoie rien tant que DISCORD_WEBHOOK_URL n'est pas configuré.
"""

import logging

import httpx

from app.config import get_settings
from app.net import CA_BUNDLE

logger = logging.getLogger("detectx.notify")
settings = get_settings()

_COLOR = {"critical": 0xE11D48, "high": 0xD97706, "medium": 0x0D9488, "low": 0x6B7280}


def enabled() -> bool:
    return bool(settings.discord_webhook_url)


async def _post(payload: dict) -> bool:
    if not enabled():
        return False
    try:
        async with httpx.AsyncClient(timeout=10.0, verify=CA_BUNDLE) as client:
            r = await client.post(settings.discord_webhook_url, json=payload)
            return r.status_code in (200, 204)
    except Exception as exc:  # noqa: BLE001
        logger.warning("Discord webhook KO: %s", exc)
        return False


async def send_test() -> bool:
    return await _post(
        {
            "username": "DeTecTX",
            "embeds": [
                {
                    "title": "Test de notification DeTecTX",
                    "description": "Si tu vois ce message, les notifications Discord fonctionnent. ✅",
                    "color": _COLOR["medium"],
                }
            ],
        }
    )


async def notify_alerts(alerts: list[dict]) -> bool:
    """Notifie les nouvelles alertes critical/high (résumé compact)."""
    important = [a for a in alerts if a.get("severity") in ("critical", "high")]
    if not important:
        return False

    top = important[:10]
    lines = [
        f"**{a['severity'].upper()}** · {a.get('mitre') or '—'} · {a['rule_title']}" for a in top
    ]
    worst = "critical" if any(a["severity"] == "critical" for a in important) else "high"
    embed = {
        "title": f"🚨 {len(important)} nouvelle(s) alerte(s) DeTecTX",
        "description": "\n".join(lines) + (f"\n… +{len(important) - len(top)} autres" if len(important) > len(top) else ""),
        "color": _COLOR[worst],
        "footer": {"text": "DeTecTX · surveillance de votre poste"},
    }
    return await _post({"username": "DeTecTX", "embeds": [embed]})
