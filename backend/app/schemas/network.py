"""Requêtes du Sonar (validation stricte : profils fermés, ids d'inventaire, libellés sans contrôle)."""

import re
from typing import Annotated, Literal

from pydantic import BaseModel, Field, StrictBool, field_validator, model_validator

DEVICE_ID_PATTERN = r"^[0-9a-f]{32}:[0-9a-f]{2}(?::[0-9a-f]{2}){5}$"  # « <clé réseau>:<mac> »
DeviceId = Annotated[str, Field(pattern=DEVICE_ID_PATTERN)]
_CONTROL = re.compile(r"[\x00-\x1f\x7f]")


class DeviceUpdate(BaseModel):
    """Renommer et/ou approuver. `label: null` efface le nom donné."""

    label: str | None = Field(default=None, max_length=80)
    approve: StrictBool = False  # « "yes" » ou « 1 » refusés : une approbation est explicite

    @field_validator("label")
    @classmethod
    def _clean_label(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if _CONTROL.search(value):
            raise ValueError("Caractères de contrôle interdits.")
        return value.strip() or None

    @model_validator(mode="after")
    def _something(self):
        if "label" not in self.model_fields_set and not self.approve:
            raise ValueError("Rien à modifier : « label » et/ou « approve » attendu.")
        return self


class ScanRequest(BaseModel):
    profile: Literal["discovery", "ports", "deep"]
    device_id: DeviceId | None = None

    @model_validator(mode="after")
    def _target(self):
        if (self.profile == "deep") != (self.device_id is not None):
            raise ValueError("« device_id » est requis pour « deep », et seulement pour lui.")
        return self


class GatewayAccept(BaseModel):
    device_id: DeviceId


class CategoryChange(BaseModel):
    """Catégorie Windows du réseau connecté. « domain » n'est jamais demandable."""

    category: Literal["private", "public"]
