"""Requêtes d'action sur le pare-feu (validation stricte avant toute élévation)."""

from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.services.fw_helper import NAME_RE

Profile = Literal["domain", "private", "public"]


class Target(BaseModel):
    proto: Literal["tcp", "udp"]
    port: Annotated[int, Field(ge=1, le=65535)]


class BlockRequest(BaseModel):
    targets: list[Target] = Field(min_length=1, max_length=20)
    profiles: list[Profile] = Field(min_length=1, max_length=3)


class UnblockRequest(BaseModel):
    name: str = Field(max_length=80, pattern=NAME_RE.pattern)
