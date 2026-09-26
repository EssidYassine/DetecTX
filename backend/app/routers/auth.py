"""Authentification : inscription, connexion (JWT), profil, MFA (TOTP)."""

import pyotp
from fastapi import APIRouter, Depends, Form, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.deps import get_current_user
from app.models.user import Role, User
from app.schemas.auth import (
    MFAEnableOut,
    MFAVerify,
    Token,
    UserCreate,
    UserOut,
)
from app.security import create_access_token, hash_password, verify_password

router = APIRouter(prefix="/auth", tags=["auth"])

_MFA_ISSUER = "DeTecTX"


@router.post("/register", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def register(payload: UserCreate, session: AsyncSession = Depends(get_session)) -> User:
    """Crée un compte. Le tout premier utilisateur devient admin (bootstrap mono-hôte)."""
    exists = await session.scalar(select(User).where(User.email == payload.email))
    if exists is not None:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="Email déjà utilisé")

    user_count = await session.scalar(select(func.count()).select_from(User))
    role = Role.admin if user_count == 0 else Role.viewer

    user = User(
        email=payload.email,
        hashed_password=hash_password(payload.password),
        role=role,
    )
    session.add(user)
    await session.commit()
    await session.refresh(user)
    return user


@router.post("/login", response_model=Token)
async def login(
    form: OAuth2PasswordRequestForm = Depends(),
    otp: str | None = Form(default=None),
    session: AsyncSession = Depends(get_session),
) -> Token:
    """Connexion. `username` = email. Exige le code TOTP si le MFA est actif."""
    user = await session.scalar(select(User).where(User.email == form.username))
    if user is None or not verify_password(form.password, user.hashed_password):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Email ou mot de passe incorrect")
    if not user.is_active:
        raise HTTPException(status.HTTP_403_FORBIDDEN, detail="Compte désactivé")

    if user.mfa_enabled:
        if not otp or not pyotp.TOTP(user.mfa_secret).verify(otp, valid_window=1):
            raise HTTPException(status.HTTP_401_UNAUTHORIZED, detail="Code MFA invalide ou manquant")

    return Token(access_token=create_access_token(subject=user.email, role=user.role.value))


@router.get("/me", response_model=UserOut)
async def me(user: User = Depends(get_current_user)) -> User:
    return user


@router.post("/mfa/enable", response_model=MFAEnableOut)
async def mfa_enable(
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> MFAEnableOut:
    """Génère un secret TOTP. Le MFA n'est activé qu'après /mfa/verify réussi."""
    if user.mfa_enabled:
        raise HTTPException(status.HTTP_409_CONFLICT, detail="MFA déjà activé")

    secret = pyotp.random_base32()
    user.mfa_secret = secret
    await session.commit()

    uri = pyotp.TOTP(secret).provisioning_uri(name=user.email, issuer_name=_MFA_ISSUER)
    return MFAEnableOut(secret=secret, provisioning_uri=uri)


@router.post("/mfa/verify", status_code=status.HTTP_204_NO_CONTENT)
async def mfa_verify(
    payload: MFAVerify,
    user: User = Depends(get_current_user),
    session: AsyncSession = Depends(get_session),
) -> None:
    """Confirme le code TOTP et active définitivement le MFA."""
    if not user.mfa_secret:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Aucun secret MFA à confirmer")
    if not pyotp.TOTP(user.mfa_secret).verify(payload.code, valid_window=1):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, detail="Code MFA incorrect")

    user.mfa_enabled = True
    await session.commit()
