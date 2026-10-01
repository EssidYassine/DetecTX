"""Sonar, couche active : exécution de Nmap et lecture de son XML.

- `find_nmap()` : l'exécutable vient de NMAP_PATH ou des dossiers d'installation standards,
  jamais d'une requête ;
- `run()` : un seul scan à la fois, sans shell, sans fenêtre, délai et taille de sortie plafonnés ;
- `parse()` est PURE : XML -> hôtes actifs, ports ouverts, système probable. Lecture par
  defusedxml (pas d'entités) ; tous les champs sont validés et tronqués avant d'aller plus loin.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import re
import subprocess
import sys
import threading
from dataclasses import dataclass
from pathlib import Path

from defusedxml import ElementTree

from app.network.neighbors import normalize_mac

log = logging.getLogger("detectx.network")

MAX_XML_BYTES = 8 * 1024 * 1024
_EXE_NAMES = {"nmap.exe", "nmap"}
# Messages de Nmap quand les paquets bruts sont refusés (Npcap absent ou réservé aux administrateurs).
_RAW_DENIED = re.compile(r"requires root privileges|dnet: Failed|Failed to open device|only ethernet devices|Npcap|WinPcap|pcap_open", re.IGNORECASE)
_busy = threading.Lock()


class ScanError(Exception):
    """Échec d'un scan : le message est destiné à l'utilisateur."""


class ScanBusy(ScanError):
    pass


class RawUnavailable(ScanError):
    """Paquets bruts refusés : seule la découverte « --unprivileged » reste possible."""


@dataclass(frozen=True)
class Port:
    proto: str
    port: int
    service: str | None = None
    product: str | None = None
    version: str | None = None


@dataclass(frozen=True)
class Host:
    ip: str
    mac: str | None = None
    vendor: str | None = None
    hostname: str | None = None
    ports: tuple[Port, ...] = ()
    os_guess: str | None = None  # « Android 9 (Linux 4.9), 98 % »
    os_type: str | None = None  # classe Nmap : phone, printer, webcam, general purpose…


# ─────────────────────────────── exécutable
def _standard_paths() -> list[Path]:
    roots = [os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)"), os.environ.get("ProgramFiles", r"C:\Program Files")]
    return [Path(r) / "Nmap" / "nmap.exe" for r in roots]


def find_nmap(configured: str = "") -> Path | None:
    candidates = [Path(configured)] if configured else _standard_paths()
    for path in candidates:
        if path.name.lower() in _EXE_NAMES and path.is_file():
            return path.resolve()
    return None


# ─────────────────────────────── lecture du XML (pure)
def _clip(value: str | None, size: int) -> str | None:
    value = (value or "").strip()
    return value[:size] if value else None


def parse(xml_text: str) -> list[Host]:
    try:
        root = ElementTree.fromstring(xml_text)
    except Exception as e:
        raise ScanError("Résultat de Nmap illisible.") from e
    if root.tag != "nmaprun":
        raise ScanError("Résultat de Nmap inattendu.")
    hosts = []
    for h in root.iter("host"):
        status = h.find("status")
        if status is None or status.get("state") != "up":
            continue
        ip = mac = vendor = None
        for a in h.findall("address"):
            if a.get("addrtype") == "ipv4":
                try:
                    ip = str(ipaddress.IPv4Address(a.get("addr", "")))
                except ValueError:
                    ip = None
            elif a.get("addrtype") == "mac":
                mac = normalize_mac(a.get("addr", ""))
                vendor = _clip(a.get("vendor"), 120)
        if ip is None:
            continue
        name = h.find("hostnames/hostname")
        ports = []
        for p in h.findall("ports/port"):
            state = p.find("state")
            proto = p.get("protocol")
            if state is None or state.get("state") != "open" or proto not in ("tcp", "udp"):
                continue
            try:
                number = int(p.get("portid", ""))
            except ValueError:
                continue
            if not 0 < number < 65536:
                continue
            svc = p.find("service")
            get = svc.get if svc is not None else (lambda _k: None)
            ports.append(Port(proto, number, _clip(get("name"), 60), _clip(get("product"), 120), _clip(get("version"), 60)))
        os_guess = os_type = None
        match = h.find("os/osmatch")
        if match is not None and match.get("name"):
            os_guess = _clip(f"{match.get('name')}, {match.get('accuracy', '?')} %", 120)
            cls = match.find("osclass")
            os_type = _clip(cls.get("type"), 40) if cls is not None else None
        hosts.append(
            Host(
                ip=ip,
                mac=mac,
                vendor=vendor,
                hostname=_clip(name.get("name"), 255) if name is not None else None,
                ports=tuple(sorted(set(ports), key=lambda x: (x.proto, x.port))),
                os_guess=os_guess,
                os_type=os_type,
            )
        )
    return hosts


# ─────────────────────────────── exécution
def run(argv: list[str], timeout_s: int) -> list[Host]:
    """Lance Nmap (argv construit par target.build_argv) et rend les hôtes actifs."""
    if not _busy.acquire(blocking=False):
        raise ScanBusy("Un scan est déjà en cours : réessayez dans un instant.")
    try:
        flags = subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
        try:
            done = subprocess.run(argv, capture_output=True, stdin=subprocess.DEVNULL, timeout=timeout_s, check=False, shell=False, creationflags=flags)
        except subprocess.TimeoutExpired as e:
            raise ScanError(f"Scan interrompu après {timeout_s} s.") from e
        except OSError as e:
            raise ScanError("Nmap n'a pas pu être lancé.") from e
    finally:
        _busy.release()
    err = done.stderr.decode("utf-8", errors="replace")
    if done.returncode != 0:
        if _RAW_DENIED.search(err):
            raise RawUnavailable("Npcap refuse les paquets bruts à DeTecTX (réservé aux administrateurs ?).")
        log.warning("nmap a échoué (code %s) : %s", done.returncode, err[-500:])
        raise ScanError(f"Nmap a échoué (code {done.returncode}).")
    if len(done.stdout) > MAX_XML_BYTES:
        raise ScanError("Résultat de Nmap trop volumineux.")
    return parse(done.stdout.decode("utf-8", errors="replace"))
