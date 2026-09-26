"""Raccourcis de lancement personnalisés (boutons définis par l'utilisateur).

Sécurité : on ne lance QUE des chemins existants ou des URL http(s) via os.startfile
(comportement « double-clic »). Pas d'exécution de commande shell arbitraire.
"""

import os
import re
import webbrowser
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user, require_role
from app.models.shortcut import AppShortcut
from app.models.user import Role, User

router = APIRouter(prefix="/launcher", tags=["launcher"])

_URL = re.compile(r"^https?://", re.IGNORECASE)


class ShortcutIn(BaseModel):
    label: str = Field(min_length=1, max_length=120)
    target: str = Field(min_length=1, max_length=500)
    icon: str | None = Field(default=None, max_length=8)


class ShortcutOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    label: str
    target: str
    icon: str | None
    created_at: datetime


def _validate_target(target: str) -> None:
    if not _URL.match(target) and not os.path.exists(target):
        raise HTTPException(422, "Cible invalide : fournir un chemin existant ou une URL http(s).")


@router.get("", response_model=list[ShortcutOut])
async def list_shortcuts(
    session: AsyncSession = Depends(get_session),
    _: User = Depends(get_current_user),
) -> list[AppShortcut]:
    rows = await session.scalars(select(AppShortcut).order_by(AppShortcut.created_at))
    return list(rows.all())


@router.post("", response_model=ShortcutOut, status_code=status.HTTP_201_CREATED)
async def create_shortcut(
    payload: ShortcutIn,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> AppShortcut:
    _validate_target(payload.target)
    sc = AppShortcut(label=payload.label, target=payload.target, icon=payload.icon or "▸")
    session.add(sc)
    await session.commit()
    await session.refresh(sc)
    return sc


@router.delete("/{sc_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_shortcut(
    sc_id: int,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> None:
    sc = await session.get(AppShortcut, sc_id)
    if sc:
        await session.delete(sc)
        await session.commit()


@router.post("/{sc_id}/launch")
async def launch_shortcut(
    sc_id: int,
    session: AsyncSession = Depends(get_session),
    _: User = Depends(require_role(Role.admin, Role.analyst)),
) -> dict:
    sc = await session.get(AppShortcut, sc_id)
    if sc is None:
        raise HTTPException(404, "Raccourci introuvable")
    try:
        if _URL.match(sc.target):
            webbrowser.open(sc.target)
        elif os.path.exists(sc.target):
            os.startfile(sc.target)  # type: ignore[attr-defined]  # Windows
        else:
            raise HTTPException(422, "Cible introuvable (déplacée/supprimée ?).")
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(500, f"Lancement échoué : {exc}")
    return {"launched": True, "label": sc.label}
