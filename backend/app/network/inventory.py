"""Sonar : ce que voit et fait l'utilisateur (inventaire, fiche, approbation, nouvelle référence).

Toute action prend un `device_id` qui DOIT appartenir au réseau courant : l'API n'accepte jamais
une IP libre (même principe que les remèdes, qui n'acceptent que des ids de l'inventaire).
"""

from __future__ import annotations

from datetime import datetime, timedelta

from sqlalchemy import delete, select

from app.config import get_settings
from app.db import SessionLocal
from app.detection import port_risk
from app.models.network import NetDevice, NetNetwork, NetPort, NetScan
from app.network import classify

settings = get_settings()
_LEVEL_RANK = {lvl: i for i, lvl in enumerate(port_risk.LEVELS)}


def _iso(value: datetime | None) -> str | None:
    return value.isoformat() if value else None


def port_view(row: NetPort, scanned_at: datetime | None) -> dict:
    profile = port_risk.profile_for(row.proto, row.port, None)
    return {
        "proto": row.proto,
        "port": row.port,
        "service": profile.service if profile.service != "Service non répertorié" else (row.service or profile.service),
        "product": row.product,
        "version": row.version,
        "open": scanned_at is not None and row.last_seen >= scanned_at,  # vu ouvert au dernier scan
        "status": row.status,
        "risk": {"level": profile.level, "why": profile.why, "attack": profile.attack},
        "first_seen": _iso(row.first_seen),
        "last_seen": _iso(row.last_seen),
    }


def device_view(d: NetDevice, net: NetNetwork, ports: list[NetPort]) -> dict:
    views = sorted((port_view(p, d.ports_scanned_at) for p in ports), key=lambda v: (v["proto"], v["port"]))
    open_levels = [v["risk"]["level"] for v in views if v["open"]]
    return {
        "id": d.id,
        "ip": d.ip,
        "mac": d.mac,
        "label": d.label,
        "hostname": d.hostname,
        "vendor": d.vendor,
        "os_guess": d.os_guess,
        "kind": d.kind,
        "kind_label": classify.LABEL.get(d.kind, d.kind),
        "randomized_mac": d.randomized,
        "status": d.status,
        "is_gateway": d.mac == net.gateway_mac,  # la box de référence
        "answers_as_gateway": d.is_gateway,  # répond en ce moment pour l'IP de la passerelle
        "gateway_mismatch": d.is_gateway and net.gateway_mac is not None and d.mac != net.gateway_mac,
        "risk": max(open_levels, key=_LEVEL_RANK.__getitem__) if open_levels else "info",
        "open_ports": sum(1 for v in views if v["open"]),
        "ports": views,
        "first_seen": _iso(d.first_seen),
        "last_seen": _iso(d.last_seen),
        "ports_scanned_at": _iso(d.ports_scanned_at),
    }


def network_view(net: NetNetwork) -> dict:
    learning_until = net.first_seen + timedelta(hours=settings.network_learning_hours) if settings.network_learning_hours else None
    return {
        "key": net.key,
        "name": net.name,
        "subnet": net.subnet,
        "gateway_ip": net.gateway_ip,
        "gateway_mac": net.gateway_mac,
        "first_seen": _iso(net.first_seen),
        "learning_until": _iso(learning_until),
        "active_baseline_at": _iso(net.active_baseline_at),
    }


async def _ports_by_device(session, ids: list[str]) -> dict[str, list[NetPort]]:
    out: dict[str, list[NetPort]] = {i: [] for i in ids}
    if ids:
        for row in (await session.scalars(select(NetPort).where(NetPort.device_id.in_(ids)))).all():
            out[row.device_id].append(row)
    return out


async def devices(key: str) -> dict | None:
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        if net is None:
            return None
        rows = (await session.scalars(select(NetDevice).where(NetDevice.network_key == key))).all()
        ports = await _ports_by_device(session, [d.id for d in rows])
    views = [device_view(d, net, ports[d.id]) for d in rows]
    order = {"new": 0, "baseline": 1, "approved": 1}
    views.sort(key=lambda v: (not v["gateway_mismatch"], order.get(v["status"], 2), not v["is_gateway"], -_LEVEL_RANK[v["risk"]], _ip_sort(v["ip"])))
    return {"network": network_view(net), "devices": views}


def _ip_sort(ip: str) -> tuple[int, ...]:
    return tuple(int(x) for x in ip.split("."))


async def device(key: str, device_id: str) -> dict | None:
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        d = await session.get(NetDevice, device_id)
        if net is None or d is None or d.network_key != key:
            return None
        ports = (await _ports_by_device(session, [d.id]))[d.id]
    return device_view(d, net, ports)


async def find_ip(key: str, device_id: str) -> str | None:
    async with SessionLocal() as session:
        d = await session.get(NetDevice, device_id)
        return d.ip if d is not None and d.network_key == key else None


async def update(key: str, device_id: str, *, label: str | None, set_label: bool, approve: bool) -> bool:
    async with SessionLocal() as session:
        d = await session.get(NetDevice, device_id)
        if d is None or d.network_key != key:
            return False
        if set_label:
            d.label = label
        if approve:
            d.status = "approved"
        await session.commit()
    return True


async def accept_gateway(key: str, device_id: str) -> str | None:
    """La box a VRAIMENT changé (remplacement) : sa MAC devient la référence. Rend l'ancienne MAC."""
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        d = await session.get(NetDevice, device_id)
        if net is None or d is None or d.network_key != key or not d.is_gateway or d.mac == net.gateway_mac:
            return None
        previous = net.gateway_mac or "—"
        net.gateway_mac = d.mac
        d.status = "approved"
        for other in (await session.scalars(select(NetDevice).where(NetDevice.network_key == key))).all():
            if other.kind == "gateway" and other.mac != d.mac:
                other.kind = classify.kind(is_gateway=False, randomized=other.randomized, hostname=other.hostname, vendor=other.vendor)
        d.kind = "gateway"
        await session.commit()
    return previous


async def reset(key: str) -> bool:
    """Nouvelle référence : le réseau est oublié, le prochain passage le réapprend (apprentissage compris)."""
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        if net is None:
            return False
        ids = list((await session.scalars(select(NetDevice.id).where(NetDevice.network_key == key))).all())
        if ids:
            await session.execute(delete(NetPort).where(NetPort.device_id.in_(ids)))
        await session.execute(delete(NetDevice).where(NetDevice.network_key == key))
        await session.delete(net)
        await session.commit()
    return True


async def nav_counts() -> tuple[int, int]:
    """(nouveaux appareils, usurpations de la box) sur le dernier réseau observé : badge de la barre
    latérale. Lecture en base seulement (pas de table ARP ni de COM toutes les 30 s)."""
    async with SessionLocal() as session:
        net = await session.scalar(select(NetNetwork).order_by(NetNetwork.last_seen.desc()).limit(1))
        if net is None:
            return 0, 0
        rows = (await session.scalars(select(NetDevice).where(NetDevice.network_key == net.key))).all()
    new = sum(1 for d in rows if d.status == "new")
    spoofed = sum(1 for d in rows if d.is_gateway and net.gateway_mac is not None and d.mac != net.gateway_mac)
    return new, spoofed


async def scans(limit: int = 20) -> list[dict]:
    async with SessionLocal() as session:
        rows = (await session.scalars(select(NetScan).order_by(NetScan.id.desc()).limit(limit))).all()
    return [
        {
            "id": s.id,
            "profile": s.profile,
            "target": s.target,
            "actor": s.actor,
            "started_at": _iso(s.started_at),
            "finished_at": _iso(s.finished_at),
            "hosts_up": s.hosts_up,
            "ok": s.ok,
            "error": s.error,
        }
        for s in rows
    ]
