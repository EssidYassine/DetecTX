"""Réseau local : chaque réseau rejoint par le poste et les appareils qu'on y a vus.

Un réseau est identifié par son nom Windows (SSID en Wi-Fi), son sous-réseau et l'IP de sa
passerelle : beaucoup de box utilisent 192.168.1.1, sans le nom on confondrait la maison et le
café. Sa passerelle a une MAC de RÉFÉRENCE : si l'IP de la passerelle répond soudain avec une
autre MAC, c'est la signature d'un empoisonnement ARP (homme du milieu).

Comme pour la persistance, le premier passage sur un réseau en fixe la référence : les
appareils présents sont « connus », seuls ceux qui arrivent ensuite sont « nouveaux ».
"""

from datetime import datetime

from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base, UTCDateTime


class NetNetwork(Base):
    __tablename__ = "net_networks"

    key: Mapped[str] = mapped_column(String(32), primary_key=True)  # empreinte (nom, sous-réseau, passerelle)
    name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    subnet: Mapped[str] = mapped_column(String(64), nullable=False)
    gateway_ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    gateway_mac: Mapped[str | None] = mapped_column(String(17), nullable=True)  # référence
    active_baseline_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)  # 1re découverte Nmap
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
    # Couche active (Nmap) : vides tant qu'aucun scan n'a vu l'appareil.
    vendor: Mapped[str | None] = mapped_column(String(120), nullable=True)
    hostname: Mapped[str | None] = mapped_column(String(255), nullable=True)
    os_guess: Mapped[str | None] = mapped_column(String(120), nullable=True)  # indice faible (« Android 9, 98 % »)
    ports_scanned_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)  # 1er scan = référence des ports


class NetPort(Base):
    """Port ouvert vu par Nmap. Un port refermé est GARDÉ (last_seen fige) : sa réouverture n'est pas une nouveauté."""

    __tablename__ = "net_ports"

    device_id: Mapped[str] = mapped_column(String(64), ForeignKey("net_devices.id"), primary_key=True)
    proto: Mapped[str] = mapped_column(String(3), primary_key=True)  # tcp|udp
    port: Mapped[int] = mapped_column(Integer, primary_key=True)
    service: Mapped[str | None] = mapped_column(String(60), nullable=True)
    product: Mapped[str | None] = mapped_column(String(120), nullable=True)
    version: Mapped[str | None] = mapped_column(String(60), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="baseline", nullable=False)  # baseline|new
    first_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)
    last_seen: Mapped[datetime] = mapped_column(UTCDateTime(), server_default=func.now(), nullable=False)


class NetScan(Base):
    """Trace de chaque scan Nmap (traçabilité : quoi, sur quoi, par qui, avec quel résultat)."""

    __tablename__ = "net_scans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    profile: Mapped[str] = mapped_column(String(20), nullable=False)
    target: Mapped[str] = mapped_column(String(64), nullable=False)
    actor: Mapped[str] = mapped_column(String(255), nullable=False)  # « système » pour les scans planifiés
    started_at: Mapped[datetime] = mapped_column(UTCDateTime(), nullable=False)
    finished_at: Mapped[datetime | None] = mapped_column(UTCDateTime(), nullable=True)
    hosts_up: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    ok: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    error: Mapped[str | None] = mapped_column(Text, nullable=True)
