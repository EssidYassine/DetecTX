"""Endpoints de génération de rapports."""

from fastapi import APIRouter, Depends
from fastapi.responses import Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models.user import User
from app.reports.pdf import build_summary_pdf

router = APIRouter(prefix="/reports", tags=["reports"])


@router.get("/summary.pdf")
async def summary_pdf(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> Response:
    data = await build_summary_pdf(session)
    return Response(
        content=data,
        media_type="application/pdf",
        headers={"Content-Disposition": "attachment; filename=detectx-rapport.pdf"},
    )
