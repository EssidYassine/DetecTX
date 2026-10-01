"""Sonar, couche active : QUOI scanner et AVEC QUELS arguments (pur, testé sans Nmap).

Principe : aucune chaîne venue de l'extérieur n'atteint la ligne de commande de Nmap.
  - l'appelant choisit un PROFIL parmi trois (pas d'option Nmap libre, pas de script NSE) ;
  - la cible est un objet `ipaddress` validé ici : le sous-réseau de l'interface de la route
    par défaut (privé, /22 au plus large), ou UNE adresse de ce sous-réseau ;
  - la chaîne finale de la cible est relue par une expression stricte (défense en profondeur).

Les profils utilisent le scan SYN (`-sS`, paquets bruts via Npcap) plutôt que le scan par
connexion (`-sT`) : un antivirus du poste (Avast…) intercepte les connexions sortantes vers les
ports mail et les fait paraître ouverts sur TOUS les appareils. Le SYN passe sous la pile TCP
de Windows et voit les vrais ports. Npcap l'autorise sans droits administrateur (réglage par
défaut) ; s'il est réservé aux administrateurs, seule la découverte fonctionne (repli
« --unprivileged »), et le scan de ports est déclaré indisponible plutôt que faux.
"""

from __future__ import annotations

import ipaddress
import re
from dataclasses import dataclass
from ipaddress import IPv4Address, IPv4Network

MIN_PREFIX = 22  # 1 024 adresses au plus
MAX_PREFIX = 30
_TARGET_RE = re.compile(r"^\d{1,3}(?:\.\d{1,3}){3}(?:/\d{1,2})?$")
_COMMON = ("--noninteractive", "-oX", "-")


@dataclass(frozen=True)
class Profile:
    id: str
    label: str
    args: tuple[str, ...]
    scope: str  # subnet | host
    timeout_s: int
    raw: bool  # a besoin des paquets bruts (Npcap)


PROFILES: dict[str, Profile] = {
    p.id: p
    for p in (
        Profile("discovery", "Découverte des appareils", ("-sn", "-T4", "--max-retries", "1", "--host-timeout", "20s"), "subnet", 180, raw=True),
        Profile("discovery-unprivileged", "Découverte (sans Npcap)", ("-sn", "--unprivileged", "-T4", "--max-retries", "1", "--host-timeout", "20s"), "subnet", 300, raw=False),
        Profile("ports", "Ports courants (100)", ("-sS", "--top-ports", "100", "-T4", "--max-retries", "1", "--host-timeout", "60s"), "subnet", 600, raw=True),
        Profile(
            "deep",
            "Analyse approfondie d'un appareil",
            ("-sS", "-sV", "--version-light", "-O", "--osscan-limit", "--top-ports", "1000", "-T4", "--max-retries", "2", "--host-timeout", "180s"),
            "host",
            300,
            raw=True,
        ),
    )
}


class TargetRefused(ValueError):
    """Cible ou profil refusé : le message est destiné à l'utilisateur."""


def scan_subnet(network: str) -> IPv4Network:
    """Sous-réseau scannable : IPv4 privé, ni boucle locale ni lien local, /22 au plus large."""
    try:
        net = ipaddress.ip_network(network, strict=False)
    except ValueError as e:
        raise TargetRefused("Sous-réseau illisible.") from e
    if not isinstance(net, IPv4Network):
        raise TargetRefused("Seuls les réseaux IPv4 sont scannés.")
    if not net.is_private or net.is_loopback or net.is_link_local or net.is_multicast or net.is_unspecified:
        raise TargetRefused(f"{net} n'est pas un réseau local privé : scan refusé.")
    if net.prefixlen < MIN_PREFIX:
        raise TargetRefused(f"{net} est trop grand (plus de 1 024 adresses) : scan refusé.")
    if net.prefixlen > MAX_PREFIX:
        raise TargetRefused(f"{net} ne contient aucun autre appareil.")
    return net


def scan_host(ip: str, subnet: IPv4Network) -> IPv4Address:
    """Une adresse du sous-réseau local (ni l'adresse du réseau, ni la diffusion)."""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError as e:
        raise TargetRefused("Adresse IP illisible.") from e
    if not isinstance(addr, IPv4Address) or addr not in subnet or addr in (subnet.network_address, subnet.broadcast_address):
        raise TargetRefused(f"{ip} n'appartient pas au réseau local {subnet} : scan refusé.")
    return addr


def build_argv(nmap: str, profile_id: str, target: IPv4Network | IPv4Address) -> list[str]:
    """Ligne de commande complète, sans shell. `target` vient de scan_subnet()/scan_host()."""
    profile = PROFILES.get(profile_id)
    if profile is None:
        raise TargetRefused("Profil de scan inconnu.")
    expected = IPv4Network if profile.scope == "subnet" else IPv4Address
    if not isinstance(target, expected):
        raise TargetRefused("Cible incompatible avec ce profil.")
    text = str(target)
    if not _TARGET_RE.fullmatch(text):  # défense en profondeur : str() d'un objet ipaddress
        raise TargetRefused("Cible refusée.")
    return [nmap, *profile.args, *_COMMON, text]
