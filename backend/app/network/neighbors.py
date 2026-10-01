"""Couche passive du Sonar : les voisins du poste, lus dans la table ARP de Windows.

Lecture native (iphlpapi via ctypes) : ni droits administrateur, ni processus lancé. Un
`Get-NetNeighbor` toutes les minutes écrirait dans le journal PowerShell que DeTecTX collecte
lui-même (événements 400/4104) : on polluerait nos propres données.

Trois appels, tous en lecture :
  GetBestRoute    interface et passerelle de la route par défaut (aucun paquet émis) ;
  GetIpAddrTable  adresse et masque de cette interface ;
  GetIpNetTable2  table des voisins IPv4 (IP, MAC, état).

Seule l'interface de la route par défaut est retenue : les cartes virtuelles (VMware, WSL,
Hyper-V) ont leurs propres « réseaux » qui ne sont pas celui où se trouve l'utilisateur.

`lan_neighbors()` est PURE (testée sans Windows) : lignes brutes -> appareils du sous-réseau.
"""

from __future__ import annotations

import ipaddress
import logging
import socket
import struct
import sys
from dataclasses import dataclass

log = logging.getLogger("detectx.network")

# NL_NEIGHBOR_STATE : 0 injoignable, 1 incomplet, 2 sondé, 3 différé, 4 périmé, 5 joignable, 6 permanent.
# « Périmé » = vu récemment mais non revérifié : l'appareil était là, on le garde.
_LIVE_STATES = frozenset({2, 3, 4, 5, 6})
_PROBE_DEST = "8.8.8.8"  # sert seulement à choisir la route par défaut : aucun paquet n'est envoyé


@dataclass(frozen=True)
class Interface:
    index: int
    ip: str
    network: str  # ex. 192.168.1.0/24
    gateway: str | None


@dataclass(frozen=True)
class NeighborRow:
    """Ligne brute de la table ARP."""

    if_index: int
    ip: str
    mac: str  # AA-BB-CC-DD-EE-FF tel que rendu par Windows
    state: int


@dataclass(frozen=True)
class Neighbor:
    ip: str
    mac: str  # aa:bb:cc:dd:ee:ff
    is_gateway: bool
    randomized: bool  # adresse « administrée localement » (MAC privée des téléphones, box, VM)


@dataclass(frozen=True)
class Observation:
    interface: Interface
    neighbors: tuple[Neighbor, ...]
    network_names: tuple[str, ...] = ()  # nom(s) Windows du réseau connecté (SSID en Wi-Fi)
    categories: tuple[str, ...] = ()  # public | private | domain (vide = inconnue)


# ─────────────────────────────── adresses MAC (pures)
def normalize_mac(raw: str) -> str | None:
    """« A2-00-00-00-00-01 » -> « a2:00:00:00:00:01 » ; None si ce n'est pas une MAC Ethernet."""
    hexa = raw.replace("-", "").replace(":", "").strip().lower()
    if len(hexa) != 12 or any(c not in "0123456789abcdef" for c in hexa):
        return None
    return ":".join(hexa[i : i + 2] for i in range(0, 12, 2))


def _first_octet(mac: str) -> int:
    return int(mac[:2], 16)


def is_unicast(mac: str) -> bool:
    """Ni multidiffusion (bit 0 du premier octet), ni adresse nulle."""
    return not (_first_octet(mac) & 0x01) and mac != "00:00:00:00:00:00"


def is_randomized(mac: str) -> bool:
    """Bit « administré localement » : MAC privée (téléphones), mais aussi certaines box et VM."""
    return bool(_first_octet(mac) & 0x02)


# ─────────────────────────────── filtrage (pur)
def lan_neighbors(interface: Interface, rows: list[NeighborRow]) -> tuple[Neighbor, ...]:
    """Appareils réels du sous-réseau de l'interface : unicast, vivants, ni diffusion ni soi-même."""
    net = ipaddress.ip_network(interface.network, strict=False)
    out: dict[str, Neighbor] = {}
    for row in rows:
        if row.if_index != interface.index or row.state not in _LIVE_STATES:
            continue
        mac = normalize_mac(row.mac)
        if mac is None or not is_unicast(mac):
            continue
        try:
            ip = ipaddress.ip_address(row.ip)
        except ValueError:
            continue
        if ip not in net or ip in (net.network_address, net.broadcast_address) or row.ip == interface.ip:
            continue
        out[row.ip] = Neighbor(ip=row.ip, mac=mac, is_gateway=row.ip == interface.gateway, randomized=is_randomized(mac))
    return tuple(sorted(out.values(), key=lambda n: ipaddress.ip_address(n.ip)))


# ─────────────────────────────── lecture Windows (iphlpapi)
def _ntoa(dword: int) -> str:
    return socket.inet_ntoa(struct.pack("<I", dword))


def _read_windows() -> tuple[Interface, list[NeighborRow]] | None:
    import ctypes
    from ctypes import wintypes

    iphlp = ctypes.WinDLL("iphlpapi")

    class ForwardRow(ctypes.Structure):  # MIB_IPFORWARDROW
        _fields_ = [(n, wintypes.DWORD) for n in ("dest", "mask", "policy", "next_hop", "if_index", "type", "proto", "age", "next_hop_as", "m1", "m2", "m3", "m4", "m5")]

    class AddrRow(ctypes.Structure):  # MIB_IPADDRROW
        _fields_ = [("addr", wintypes.DWORD), ("index", wintypes.DWORD), ("mask", wintypes.DWORD), ("bcast", wintypes.DWORD), ("reasm", wintypes.DWORD), ("unused", ctypes.c_ushort), ("type", ctypes.c_ushort)]

    class NetRow2(ctypes.Structure):  # MIB_IPNET_ROW2 (88 octets en x64)
        _fields_ = [
            ("address", ctypes.c_ubyte * 28),  # SOCKADDR_INET
            ("if_index", ctypes.c_ulong),
            ("luid", ctypes.c_uint64),
            ("phys", ctypes.c_ubyte * 32),
            ("phys_len", ctypes.c_ulong),
            ("state", ctypes.c_int),
            ("flags", ctypes.c_ubyte),
            ("reachability", ctypes.c_ulong),
        ]

    route = ForwardRow()
    probe = struct.unpack("<I", socket.inet_aton(_PROBE_DEST))[0]
    if iphlp.GetBestRoute(probe, 0, ctypes.byref(route)) != 0:
        return None  # pas de route par défaut : hors ligne
    gateway = _ntoa(route.next_hop) if route.next_hop else None

    size = wintypes.ULONG(0)
    iphlp.GetIpAddrTable(None, ctypes.byref(size), False)
    buf = ctypes.create_string_buffer(size.value)
    if iphlp.GetIpAddrTable(buf, ctypes.byref(size), False) != 0:
        return None
    count = struct.unpack_from("<I", buf, 0)[0]
    local = next((a for a in (AddrRow * count).from_buffer_copy(buf, 4) if a.index == route.if_index), None)
    if local is None:
        return None
    ip, mask = _ntoa(local.addr), _ntoa(local.mask)
    interface = Interface(index=route.if_index, ip=ip, network=str(ipaddress.ip_network(f"{ip}/{mask}", strict=False)), gateway=gateway)

    table = ctypes.c_void_p()
    if iphlp.GetIpNetTable2(socket.AF_INET, ctypes.byref(table)) != 0:
        return None
    try:
        num = ctypes.c_ulong.from_address(table.value).value
        rows = []
        for r in (NetRow2 * num).from_address(table.value + 8):  # NumEntries puis alignement sur 8
            raw = bytes(r.address)
            if struct.unpack_from("<H", raw, 0)[0] != socket.AF_INET:
                continue
            mac = "-".join(f"{b:02X}" for b in r.phys[: min(r.phys_len, 32)])
            rows.append(NeighborRow(if_index=r.if_index, ip=socket.inet_ntoa(raw[4:8]), mac=mac, state=r.state))
    finally:
        iphlp.FreeMibTable(table)
    return interface, rows


def observe() -> Observation | None:
    """Voisins du poste sur le réseau de la route par défaut ; None hors Windows ou hors ligne."""
    if sys.platform != "win32":
        return None
    from app.services import firewall

    try:
        read = _read_windows()
    except OSError:
        log.warning("lecture de la table ARP impossible", exc_info=True)
        return None
    if read is None:
        return None
    interface, rows = read
    networks = firewall.connected_networks()
    names = tuple(sorted(n["name"] for n in networks if n.get("name")))
    categories = tuple(sorted({n["category"] for n in networks if n.get("category")}))
    return Observation(interface=interface, neighbors=lan_neighbors(interface, rows), network_names=names, categories=categories)
