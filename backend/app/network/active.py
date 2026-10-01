"""Sonar, couche active : Nmap enrichit et complète la couche passive.

- `block_reason()` (pur) : quand NE PAS scanner. Réseau classé Public (café, école, hôtel) ou de
  catégorie inconnue, Nmap absent, scans désactivés. Aucun contournement silencieux : pour scanner
  chez soi, on passe le réseau en « Privé » dans Windows.
- `discovery()` : qui est là. Les hôtes trouvés passent par la MÊME réconciliation que la table
  ARP (nouvel appareil, passerelle usurpée), puis fabricant / nom / système enrichissent la fiche.
- `port_scan()` : ports courants de tout le sous-réseau. Premier scan d'un appareil = sa
  référence ; ensuite un port qui s'ouvre lève une alerte.

Deux détections de plus :
  network-new-port        port ouvert absent de la référence de l'appareil (sévérité port_risk) ;
  network-risky-service   au premier scan, service à risque élevé ou critique (Telnet, SMB, RDP,
                          base de données…) exposé par un appareil.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select

from app.db import SessionLocal
from app.detection import port_risk
from app.models.network import NetDevice, NetNetwork, NetPort, NetScan
from app.network import classify, neighbors, nmap_runner, oui, service, target
from app.network.neighbors import Neighbor, Observation, is_randomized, is_unicast
from app.network.nmap_runner import Host, Port, RawUnavailable, ScanError

log = logging.getLogger("detectx.network")

SYSTEM_ACTOR = "système"
_SEVERITY = {"info": "low", "low": "low", "medium": "medium", "high": "high", "critical": "critical"}
_DEVICE_ADVICE = (
    "Si ce service n'est pas voulu, le désactiver dans l'interface d'administration de l'appareil ; "
    "sinon le protéger (mot de passe fort, mise à jour du micrologiciel) et le réserver au réseau local."
)

# raw : None = pas encore essayé, True = scan SYN possible, False = Npcap réservé aux administrateurs.
_state: dict = {"raw": None}


def block_reason(*, enabled: bool, nmap: Path | None, categories: tuple[str, ...]) -> str | None:
    if not enabled:
        return "Scans actifs désactivés (NETWORK_ACTIVE_SCAN=false) : seule la couche passive tourne."
    if nmap is None:
        return "Nmap n'est pas installé : installez Nmap (avec Npcap) depuis nmap.org pour l'inventaire complet."
    if not categories:
        return "Catégorie du réseau inconnue : scan actif suspendu par prudence."
    if "public" in categories:
        return (
            "Réseau classé Public par Windows : scan actif refusé (café, école, hôtel… scanner sans autorisation "
            "peut être illégal). Chez vous ? Passez ce réseau en Privé dans les paramètres Windows."
        )
    return None


# ─────────────────────────────── fusion Nmap + table ARP (pure)
def merge(obs: Observation, hosts: list[Host]) -> Observation:
    """Ajoute à l'observation les hôtes vus par Nmap (sans le poste, hors sous-réseau ignorés).

    MAC : celle de la réponse ARP reçue par Nmap (la plus fraîche), sinon celle de la table ARP
    (découverte « --unprivileged », qui ne voit pas les MAC). Sans MAC, pas d'identité : ignoré.
    """
    net = ipaddress.ip_network(obs.interface.network, strict=False)
    by_ip = {n.ip: n for n in obs.neighbors}
    for h in hosts:
        addr = ipaddress.ip_address(h.ip)
        if h.ip == obs.interface.ip or addr not in net or addr in (net.network_address, net.broadcast_address):
            continue
        mac = h.mac or (by_ip[h.ip].mac if h.ip in by_ip else None)
        if mac is None or not is_unicast(mac):
            continue
        by_ip[h.ip] = Neighbor(ip=h.ip, mac=mac, is_gateway=h.ip == obs.interface.gateway, randomized=is_randomized(mac))
    return replace(obs, neighbors=tuple(sorted(by_ip.values(), key=lambda n: ipaddress.ip_address(n.ip))))


# ─────────────────────────────── ports (pur)
def _describe(p: Port, profile: port_risk.PortProfile) -> str:
    software = " ".join(x for x in (p.product, p.version) if x)
    return f"{profile.service} ({p.proto.upper()} {p.port}" + (f", {software}" if software else "") + ")"


def assess_ports(*, device_id: str, who: str, first_scan: bool, known: set[tuple[str, int]], ports: tuple[Port, ...], now: datetime) -> list[dict]:
    out = []
    for p in ports:
        profile = port_risk.profile_for(p.proto, p.port, None)
        severity = _SEVERITY[profile.level]
        what = _describe(p, profile)
        body = f"{profile.why}\nSource : scan SYN Nmap ({now:%d/%m/%Y %H:%M} UTC).\nÀ faire : {_DEVICE_ADVICE}"
        if first_scan:
            if profile.level in ("high", "critical"):
                out.append(
                    service.alert_candidate(
                        f"net-risk:{device_id}:{p.proto}/{p.port}",
                        "network-risky-service",
                        f"Service à risque exposé par {who} : {what}",
                        severity,
                        profile.attack,
                        f"{who} expose {what} sur le réseau local.\n{body}",
                        now,
                    )
                )
        elif (p.proto, p.port) not in known:
            out.append(
                service.alert_candidate(
                    f"net-port:{device_id}:{p.proto}/{p.port}",
                    "network-new-port",
                    f"Nouveau port ouvert sur {who} : {what}",
                    severity,
                    profile.attack,
                    f"{who} n'exposait pas {what} lors des scans précédents.\n{body}",
                    now,
                )
            )
    return out


def _who(device: NetDevice) -> str:
    name = device.label or (device.hostname.split(".")[0] if device.hostname else None)
    return f"« {name} » ({device.ip})" if name else device.ip


# ─────────────────────────────── base de données
async def _devices(session, key: str) -> list[NetDevice]:
    return list((await session.scalars(select(NetDevice).where(NetDevice.network_key == key))).all())


async def _ports_of(session, device_ids: list[str]) -> dict[str, list[NetPort]]:
    out: dict[str, list[NetPort]] = {i: [] for i in device_ids}
    if device_ids:
        for row in (await session.scalars(select(NetPort).where(NetPort.device_id.in_(device_ids)))).all():
            out[row.device_id].append(row)
    return out


def _reclassify(device: NetDevice, gateway_mac: str | None, ports: set[int], os_type: str | None = None) -> None:
    device.kind = classify.kind(
        is_gateway=device.mac == gateway_mac,
        randomized=device.randomized,
        ports=frozenset(ports),
        hostname=device.hostname,
        vendor=device.vendor,
        os_type=os_type,
    )


async def enrich(key: str, hosts: list[Host], nmap: Path | None) -> None:
    """Fabricant (Nmap, sinon base IEEE de Nmap), nom d'hôte, système probable, puis nouveau classement."""
    by_mac = {h.mac: h for h in hosts if h.mac}
    by_ip = {h.ip: h for h in hosts}
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        if net is None:
            return
        devices = await _devices(session, key)
        ports = await _ports_of(session, [d.id for d in devices])
        for d in devices:
            h = by_mac.get(d.mac) or (by_ip.get(d.ip) if d.ip in by_ip and not by_ip[d.ip].mac else None)
            if h is not None:
                d.vendor = h.vendor or d.vendor
                d.hostname = h.hostname or d.hostname
                d.os_guess = h.os_guess or d.os_guess
            if d.vendor is None:
                d.vendor = oui.vendor(d.mac, nmap)
            _reclassify(d, net.gateway_mac, {p.port for p in ports[d.id]}, h.os_type if h else None)
        await session.commit()


async def ingest_ports(key: str, hosts: list[Host], now: datetime) -> list[dict]:
    """Rapproche les ports vus de la référence de chaque appareil ; rend les candidats d'alerte."""
    candidates: list[dict] = []
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        if net is None:
            return []
        devices = await _devices(session, key)
        by_mac = {d.mac: d for d in devices}
        by_ip = {d.ip: d for d in devices}
        rows = await _ports_of(session, [d.id for d in devices])
        for h in hosts:
            device = by_mac.get(h.mac) if h.mac else by_ip.get(h.ip)
            if device is None:
                continue  # pas encore réconcilié (la découverte passe avant)
            first = device.ports_scanned_at is None
            existing = {(r.proto, r.port): r for r in rows[device.id]}
            candidates += assess_ports(device_id=device.id, who=_who(device), first_scan=first, known=set(existing), ports=h.ports, now=now)
            for p in h.ports:
                row = existing.get((p.proto, p.port))
                if row is None:
                    row = NetPort(device_id=device.id, proto=p.proto, port=p.port, status="baseline" if first else "new", first_seen=now, last_seen=now)
                    session.add(row)
                    existing[(p.proto, p.port)] = row
                row.last_seen = now
                row.service = p.service or row.service
                row.product = p.product or row.product
                row.version = p.version or row.version
            device.ports_scanned_at = now
            _reclassify(device, net.gateway_mac, {port for _proto, port in existing}, h.os_type)
        await session.commit()
    return candidates


async def _record(profile: str, scope: str, actor: str, started: datetime, hosts_up: int, error: str | None) -> None:
    async with SessionLocal() as session:
        session.add(
            NetScan(profile=profile, target=scope, actor=actor[:255], started_at=started, finished_at=datetime.now(timezone.utc), hosts_up=hosts_up, ok=error is None, error=error)
        )
        await session.commit()


async def _run(nmap: Path, profile: str, scan_target, actor: str) -> list[Host]:
    started = datetime.now(timezone.utc)
    argv = target.build_argv(str(nmap), profile, scan_target)
    try:
        hosts = await asyncio.to_thread(nmap_runner.run, argv, target.PROFILES[profile].timeout_s)
    except ScanError as e:
        await _record(profile, str(scan_target), actor, started, 0, str(e))
        raise
    await _record(profile, str(scan_target), actor, started, len(hosts), None)
    return hosts


# ─────────────────────────────── scans
async def discovery(obs: Observation, nmap: Path, actor: str = SYSTEM_ACTOR) -> list[dict]:
    subnet = target.scan_subnet(obs.interface.network)
    if _state["raw"] is False:
        hosts = await _run(nmap, "discovery-unprivileged", subnet, actor)
    else:
        try:
            hosts = await _run(nmap, "discovery", subnet, actor)
            _state["raw"] = True
        except RawUnavailable:
            _state["raw"] = False
            hosts = await _run(nmap, "discovery-unprivileged", subnet, actor)
    # Le scan a rempli la table ARP : relue pour les MAC que « --unprivileged » ne voit pas.
    fresh = await asyncio.to_thread(neighbors.observe) or obs
    merged = merge(fresh, hosts)
    key = service.network_key(merged)
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        first_active = net is not None and net.active_baseline_at is None
    created = await service.reconcile(merged, extend_baseline=first_active)
    await enrich(key, hosts, nmap)
    return created


async def port_scan(obs: Observation, nmap: Path, actor: str = SYSTEM_ACTOR) -> list[dict]:
    if _state["raw"] is False:
        raise ScanError("Scan de ports indisponible : Npcap est réservé aux administrateurs (le scan par connexion serait faussé par l'antivirus).")
    subnet = target.scan_subnet(obs.interface.network)
    hosts = [h for h in await _run(nmap, "ports", subnet, actor) if h.ip != obs.interface.ip]
    return await service.raise_alerts(await ingest_ports(service.network_key(obs), hosts, datetime.now(timezone.utc)))


def raw_available() -> bool | None:
    return _state["raw"]
