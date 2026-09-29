"""Schémas des règles de détection personnalisées."""

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.schemas.events import EventOut

MAX_KEYWORDS = 10


class RuleIn(BaseModel):
    """Règle saisie dans l'interface. Sémantique (identique au moteur) : journal ET event_id ET
    au moins un des mots-clés présent dans le message (insensible à la casse, littéral)."""

    title: str = Field(min_length=3, max_length=255)
    description: str | None = Field(default=None, max_length=2000)
    level: str = Field(default="medium", pattern="^(critical|high|medium|low)$")
    mitre: str | None = Field(default=None, pattern=r"^T\d{4}(\.\d{3})?$")
    channel: str | None = Field(default=None, max_length=255, pattern=r"^[A-Za-z0-9 ._/()-]+$")
    event_id: int | None = Field(default=None, ge=0, le=65535)
    keywords: list[str] = Field(default_factory=list, max_length=MAX_KEYWORDS)
    threshold_count: int | None = Field(default=None, ge=1, le=100_000)
    threshold_minutes: int | None = Field(default=None, ge=1, le=60 * 24 * 7)

    @field_validator("mitre", "channel", "description", mode="before")
    @classmethod
    def _blank_is_none(cls, v):
        return None if isinstance(v, str) and not v.strip() else v

    @field_validator("title")
    @classmethod
    def _strip_title(cls, v: str) -> str:
        return " ".join(v.split())

    @field_validator("keywords")
    @classmethod
    def _clean_keywords(cls, v: list[str]) -> list[str]:
        out: list[str] = []
        for k in v:
            k = " ".join(str(k).split())
            if not k:
                continue
            if not 2 <= len(k) <= 200:
                raise ValueError("Chaque mot-clé doit faire entre 2 et 200 caractères.")
            if k.lower() not in (x.lower() for x in out):
                out.append(k)
        return out

    @model_validator(mode="after")
    def _threshold_pair(self) -> "RuleIn":
        if (self.threshold_count is None) != (self.threshold_minutes is None):
            raise ValueError("Un seuil exige à la fois un nombre d'occurrences et une durée.")
        return self


class RuleOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    rule_id: str
    title: str
    description: str | None
    level: str
    mitre: str | None
    channel: str | None
    event_id: int | None
    keywords: list[str]
    threshold_count: int | None
    threshold_minutes: int | None
    enabled: bool
    created_at: datetime
    alerts: int = 0  # alertes produites par cette règle


class RulePreview(BaseModel):
    """Ce que la règle aurait trouvé, AVANT de l'enregistrer (évite les règles aveugles ou bruyantes)."""

    matches_24h: int
    matches_7d: int
    samples: list[EventOut]
    noisy: bool  # plus de NOISY_PER_DAY correspondances par jour : trop d'alertes à trier
    would_alert: int  # alertes qu'une exécution créerait (plafond du moteur : 200 par règle ; seuil : 0 ou 1)
