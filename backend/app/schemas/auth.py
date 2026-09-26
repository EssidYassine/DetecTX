"""Schémas d'entrée/sortie de l'authentification."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, EmailStr, Field

from app.models.user import Role


class UserCreate(BaseModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=128)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    otp: str | None = Field(default=None, description="Code TOTP à 6 chiffres si MFA actif")


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: EmailStr
    role: Role
    is_active: bool
    mfa_enabled: bool
    created_at: datetime


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


class MFAEnableOut(BaseModel):
    secret: str
    provisioning_uri: str = Field(description="URI otpauth:// à scanner (Google Authenticator, etc.)")


class MFAVerify(BaseModel):
    code: str = Field(min_length=6, max_length=6)
