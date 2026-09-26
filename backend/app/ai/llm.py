"""Abstraction LLM : OpenAI / Anthropic / Ollama.

`complete()` renvoie le texte de complétion, ou None si aucun provider n'est
disponible/configuré (le repli déterministe prend alors le relais).
"""

import logging

import httpx

from app.config import get_settings
from app.net import CA_BUNDLE

logger = logging.getLogger("detectx.ai")
settings = get_settings()

_TIMEOUT = httpx.Timeout(45.0)


def provider_name() -> str:
    return settings.llm_provider


async def complete(system: str, prompt: str) -> str | None:
    provider = settings.llm_provider
    try:
        if provider == "openai":
            return await _openai(system, prompt)
        if provider == "anthropic":
            return await _anthropic(system, prompt)
        if provider == "ollama":
            return await _ollama(system, prompt)
    except Exception as exc:  # noqa: BLE001 — repli déterministe en cas d'échec
        logger.warning("LLM (%s) indisponible: %s", provider, exc)
    return None


async def _openai(system: str, prompt: str) -> str | None:
    if not settings.openai_api_key:
        return None
    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=CA_BUNDLE) as client:
        r = await client.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {settings.openai_api_key}"},
            json={
                "model": settings.openai_model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
                "temperature": 0.2,
            },
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"]


async def _anthropic(system: str, prompt: str) -> str | None:
    if not settings.anthropic_api_key:
        return None
    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=CA_BUNDLE) as client:
        r = await client.post(
            "https://api.anthropic.com/v1/messages",
            headers={
                "x-api-key": settings.anthropic_api_key,
                "anthropic-version": "2023-06-01",
            },
            json={
                "model": settings.anthropic_model,
                "max_tokens": 1024,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        r.raise_for_status()
        return r.json()["content"][0]["text"]


async def _ollama(system: str, prompt: str) -> str | None:
    async with httpx.AsyncClient(timeout=_TIMEOUT, verify=CA_BUNDLE) as client:
        r = await client.post(
            f"{settings.ollama_base_url}/api/generate",
            json={
                "model": settings.ollama_model,
                "system": system,
                "prompt": prompt,
                "stream": False,
            },
        )
        r.raise_for_status()
        return r.json().get("response")
