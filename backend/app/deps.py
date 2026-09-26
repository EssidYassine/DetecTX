"""Dépendances FastAPI : utilisateur courant et contrôle d'accès RBAC."""

from collections.abc import Callable

from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.models.user import Role, User
from app.security import decode_access_token

oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")

_credentials_error = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Identifiants invalides",
    headers={"WWW-Authenticate": "Bearer"},
)


async def get_current_user(
    token: str = Depends(oauth2_scheme),
    session: AsyncSession = Depends(get_session),
) -> User:
    payload = decode_access_token(token)
    if payload is None or "sub" not in payload:
        raise _credentials_error

    user = await session.scalar(select(User).where(User.email == payload["sub"]))
    if user is None or not user.is_active:
        raise _credentials_error
    return user


def require_role(*allowed: Role) -> Callable[[User], User]:
    """Fabrique une dépendance qui exige un des rôles donnés."""

    async def _checker(user: User = Depends(get_current_user)) -> User:
        if user.role not in allowed:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Droits insuffisants pour cette action",
            )
        return user

    return _checker
