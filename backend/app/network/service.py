"""Sonar : référence du réseau local et détections d'appareils (la boucle est dans sonar.py).

Deux détections :
  network-gateway-mac-change  l'IP de la passerelle répond avec une autre MAC que sa référence :
                              signature d'un empoisonnement ARP (homme du milieu, T1557.002).
                              Critique si le réseau est identifié par son nom, élevée sinon.
  network-new-device          une MAC jamais vue sur ce réseau depuis la référence (T1200).
                              Faible si la MAC est privée (téléphone qui se reconnecte), moyenne sinon.

Ce qui n'alerte PAS, volontairement :
  - le premier passage sur un réseau (il fixe la référence), puis la période d'APPRENTISSAGE
    (NETWORK_LEARNING_HOURS, 24 h) : la table ARP ne montre que les appareils qui ont parlé au
    poste, le reste du foyer y apparaît au fil des heures. La passerelle, elle, est contrôlée
    dès la première minute ;
  - un appareil qui change d'IP (bail DHCP) ou qui revient après une absence ;
  - un autre réseau qui utilise la même IP de passerelle (la clé inclut le nom du réseau).

`assess()` est PURE : observation + référence -> candidats d'alerte. La base n'est touchée
que par `reconcile()`.
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app import notify
from app.config import get_settings
from app.db import SessionLocal
from app.models.network import NetDevice, NetNetwork
from app.network import classify
from app.network.neighbors import Neighbor, Observation
from app.services.alerts import save_alerts

log = logging.getLogger("detectx.network")
settings = get_settings()

CHANNEL = "DeTecTX/Réseau"
_SCORE = {"critical": 90, "high": 70, "medium": 45, "low": 20}  # mêmes paliers que le moteur


@dataclass(frozen=True)
class Known:
    """Référence d'un réseau déjà rencontré."""

    gateway_mac: str | None
    macs: frozenset[str]


def network_key(obs: Observation) -> str:
    raw = "|".join((*obs.network_names, obs.interface.network, obs.interface.gateway or "-"))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:32]


def network_label(obs: Observation) -> str:
    return " + ".join(obs.network_names) or f"réseau {obs.interface.network}"


def _gateway(obs: Observation) -> Neighbor | None:
    return next((n for n in obs.neighbors if n.is_gateway), None)


def alert_candidate(key: str, rule: str, title: str, severity: str, mitre: str, message: str, now: datetime) -> dict:
    return {
        "dedup_key": key[:255],
        "rule_id": rule,
        "rule_title": title[:255],
        "severity": severity,
        "risk_score": _SCORE[severity],
        "mitre": mitre,
        "channel": CHANNEL,
        "event_id": None,
        "event_record_id": None,
        "event_timestamp": now,
        "message": message[:4000],
    }


def assess(obs: Observation, known: Known | None, key: str, now: datetime) -> list[dict]:
    """Candidats d'alerte pour cette observation (aucun au premier passage : c'est la référence)."""
    if known is None:
        return []
    where = network_label(obs)
    out: list[dict] = []

    gw = _gateway(obs)
    if gw is not None and known.gateway_mac and gw.mac != known.gateway_mac:
        identified = bool(obs.network_names)
        twins = [n.ip for n in obs.neighbors if n.mac == gw.mac and not n.is_gateway]
        evidence = [
            f"Réseau : {where} ({obs.interface.network}), table ARP de l'interface {obs.interface.ip}.",
            f"Passerelle {gw.ip} : MAC de référence {known.gateway_mac}, MAC observée {gw.mac}.",
        ]
        if twins:
            evidence.append(
                f"Cette MAC est AUSSI celle de {', '.join(twins)} : un appareil du réseau se fait passer pour la box "
                "(signature typique d'une attaque de l'homme du milieu)."
            )
        if not identified:
            evidence.append("Nom du réseau inconnu : un changement de réseau ne peut pas être exclu.")
        evidence.append(
            "À faire : se déconnecter du réseau, vérifier l'étiquette de la box (adresse MAC), "
            "puis approuver la nouvelle MAC seulement si la box a été remplacée."
        )
        out.append(
            alert_candidate(
                f"net-gw:{key}:{gw.mac}",
                "network-gateway-mac-change",
                f"Passerelle usurpée ? La box {gw.ip} répond avec une autre adresse MAC",
                "critical" if identified else "high",
                "T1557.002",
                "\n".join(evidence),
                now,
            )
        )

    for n in obs.neighbors:
        if n.is_gateway or n.mac in known.macs:
            continue  # la passerelle est couverte par la règle ci-dessus
        private = " (adresse MAC privée : souvent un téléphone ou une tablette)" if n.randomized else ""
        out.append(
            alert_candidate(
                f"net-new:{key}:{n.mac}",
                "network-new-device",
                f"Nouvel appareil sur {where} : {n.ip}",
                "low" if n.randomized else "medium",
                "T1200",
                (
                    f"Appareil jamais vu sur {where} ({obs.interface.network}) depuis la référence.\n"
                    f"IP {n.ip}, MAC {n.mac}{private}.\n"
                    "Source : table ARP de Windows (couche passive du Sonar).\n"
                    "À faire : identifier l'appareil (le vôtre, un invité ?) puis l'approuver ; sinon changer le mot de passe du Wi-Fi."
                ),
                now,
            )
        )
    return out


async def raise_alerts(candidates: list[dict]) -> list[dict]:
    """Enregistre les candidats (dédupliqués) et notifie les alertes créées."""
    if not candidates:
        return []
    async with SessionLocal() as session:
        created = await save_alerts(session, candidates)
    if created and notify.enabled():
        try:
            await notify.notify_alerts(created)
        except Exception:
            log.warning("notification des alertes réseau impossible", exc_info=True)
    return created


async def reconcile(obs: Observation, *, now: datetime | None = None, extend_baseline: bool = False) -> list[dict]:
    """Rapproche l'observation de la référence du réseau, l'enregistre, lève et notifie les alertes.

    extend_baseline : 1re découverte ACTIVE d'un réseau déjà connu par la couche passive. Nmap voit
    d'un coup des appareils présents depuis toujours, mais silencieux pour la table ARP : ils
    rejoignent la référence sans alerte « nouvel appareil ». Le contrôle de la passerelle reste actif.
    """
    now = now or datetime.now(timezone.utc)
    key = network_key(obs)
    gw = _gateway(obs)
    async with SessionLocal() as session:
        net = await session.get(NetNetwork, key)
        devices = {d.mac: d for d in (await session.scalars(select(NetDevice).where(NetDevice.network_key == key))).all()}
        known = None if net is None else Known(gateway_mac=net.gateway_mac, macs=frozenset(devices))
        hours = settings.network_learning_hours
        learning = net is not None and hours > 0 and now < net.first_seen + timedelta(hours=hours)
        absorb = known is not None and (extend_baseline or learning)
        if absorb:
            known = Known(gateway_mac=known.gateway_mac, macs=known.macs | {n.mac for n in obs.neighbors if not n.is_gateway})
        candidates = assess(obs, known, key, now)
        new_status = "baseline" if known is None or absorb else "new"

        if net is None:
            net = NetNetwork(key=key, name=" + ".join(obs.network_names)[:255] or None, subnet=obs.interface.network, gateway_ip=obs.interface.gateway, first_seen=now, last_seen=now)
            session.add(net)
        net.last_seen = now
        if gw is not None and net.gateway_mac is None:
            net.gateway_mac = gw.mac  # passerelle absente de la table ARP au premier passage : adoptée à sa 1re apparition

        for n in obs.neighbors:
            device = devices.get(n.mac)
            if device is None:
                device = NetDevice(
                    id=f"{key}:{n.mac}",
                    network_key=key,
                    mac=n.mac,
                    ip=n.ip,
                    # « Box » = la passerelle de RÉFÉRENCE : un appareil qui usurpe son IP n'en devient pas une.
                    kind=classify.kind(is_gateway=n.mac == net.gateway_mac, randomized=n.randomized),
                    randomized=n.randomized,
                    is_gateway=n.is_gateway,
                    status=new_status,
                    first_seen=now,
                    last_seen=now,
                )
                session.add(device)
                devices[n.mac] = device
            else:
                device.ip = n.ip
                device.last_seen = now
        for device in devices.values():
            if gw is not None:  # répond pour l'IP de la passerelle en ce moment (une seule MAC à la fois)
                device.is_gateway = device.mac == gw.mac
            if device.mac == net.gateway_mac:
                device.kind = "gateway"  # passerelle adoptée après le premier passage
        if extend_baseline:
            net.active_baseline_at = now
        await session.commit()

    return await raise_alerts(candidates)
