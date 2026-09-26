"""Endpoints de la couche IA : explication d'alerte et assistant SOC."""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai import explain, llm
from app.db import get_session
from app.deps import get_current_user
from app.models.alert import Alert
from app.models.user import User
from app.schemas.ai import ChatRequest, ChatResponse, ExplanationOut
from app.services import alerts as alerts_svc

router = APIRouter(prefix="/ai", tags=["ai"])


@router.get("/status")
async def status_(_: User = Depends(get_current_user)) -> dict:
    return {"provider": llm.provider_name()}


@router.post("/alerts/{alert_id}/explain", response_model=ExplanationOut)
async def explain_alert(
    alert_id: int,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> ExplanationOut:
    alert = await session.get(Alert, alert_id)
    if alert is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="Alerte introuvable")
    return await explain.explain_alert(alert)


async def _build_context(session: AsyncSession, alert_id: int | None) -> str:
    lines: list[str] = []
    if alert_id is not None:
        a = await session.get(Alert, alert_id)
        if a:
            lines.append(
                f"[Alerte ciblée] {a.severity} · {a.rule_title} · {a.mitre or '—'} · "
                f"{a.channel} · {(a.message or '')[:300]}"
            )
    page = await alerts_svc.list_alerts(session, limit=15)
    for a in page.items:
        lines.append(f"- {a.severity} · {a.rule_title} · {a.mitre or '—'} · {a.channel}")
    return "\n".join(lines) if lines else "Aucune alerte pour l'instant."


@router.post("/chat", response_model=ChatResponse)
async def chat(
    payload: ChatRequest,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> ChatResponse:
    context = await _build_context(session, payload.alert_id)
    answer, provider = await explain.answer_question(payload.question, context)
    return ChatResponse(answer=answer, provider=provider)
