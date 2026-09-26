"""Schémas de la couche IA."""

from pydantic import BaseModel


class ExplanationOut(BaseModel):
    alert_id: int
    rule_title: str
    severity: str
    mitre_id: str
    mitre_name: str
    tactic: str
    description: str
    cause: str
    impact: str
    remediation: list[str]
    commands: list[str]
    references: list[str]
    source: str  # builtin | openai | anthropic | ollama
    ai_narrative: str | None = None


class ChatRequest(BaseModel):
    question: str
    alert_id: int | None = None


class ChatResponse(BaseModel):
    answer: str
    provider: str  # builtin | openai | anthropic | ollama
