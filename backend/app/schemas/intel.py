"""Schémas Threat Intelligence."""

from pydantic import BaseModel


class ProviderResult(BaseModel):
    provider: str
    available: bool
    verdict: str  # clean | suspicious | malicious | known | unknown | error
    score: int | None = None
    detail: str
    link: str | None = None


class IntelResult(BaseModel):
    indicator: str
    type: str
    verdict: str  # verdict global
    providers: list[ProviderResult]
    cached: bool = False
