"""Réseau local : chaque réseau rejoint par le poste et les appareils qu'on y a vus.

Un réseau est identifié par son nom Windows (SSID en Wi-Fi), son sous-réseau et l'IP de sa
passerelle : beaucoup de box utilisent 192.168.1.1, sans le nom on confondrait la maison et le
café. Sa passerelle a une MAC de RÉFÉRENCE : si l'IP de la passerelle répond soudain avec une
autre MAC, c'est la signature d'un empoisonnement ARP (homme du milieu).

Comme pour la persistance, le premier passage sur un réseau en fixe la référence : les
appareils présents sont « connus », seuls ceux qui arrivent ensuite sont « nouveaux ».
"""

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class NetNetwork(Base):
    __tablename__ = "net_networks"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)  # empreinte (nom, sous-réseau, passerelle)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    subnet: Mapped[str] = mapped_column(String(64), nullable=False)
    gateway_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    gateway_mac: Mapped[str | None] = mapped_column(String(17), nullable=True)  # référence
    first_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)


class NetDevice(Base):
    __tablename__ = "net_devices"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # « <clé réseau>:<mac> »
    network_key: Mapped[str] = mapped_column(String(32), ForeignKey("net_networks.key"), index=True, nullable=False)
    mac: Mapped[str] = mapped_column(String(17), nullable=False)
    ip: Mapped[str] = mapped_column(String(45), nullable=False)
    kind: Mapped[str] = mapped_column(String(20), default="unknown", nullable=False)
    randomized: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    is_gateway: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    label: Mapped[str | None] = mapped_column(String(80), nullable=True)  # nom donné par l'utilisateur
    status: Mapped[str] = mapped_column(String(20), default="baseline", nullable=False)  # baseline|new|approved
    first_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)
