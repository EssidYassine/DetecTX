"""Type probable d'un appareil du réseau local (pur, testé sans Windows).

Indices, du plus fiable au plus faible :
  1. rôle de passerelle (la box, même si sa MAC est « administrée localement ») ;
  2. ports très spécifiques (impression 9100/631, flux vidéo 554) ;
  3. nom d'hôte annoncé (« iPhone », « Galaxy-A04 », « DESKTOP-… ») ;
  4. ports ambigus (AirPlay, partage de fichiers, SSH…) ;
  5. fabricant de la carte réseau (base IEEE de Nmap) ;
  6. MAC privée : réglage par défaut des téléphones ;
  7. classe du système devinée par Nmap : indice FAIBLE (une box OpenWrt passe pour « Android »).
Les motifs sont ancrés sur des mots entiers : « Brother » ne doit pas attraper « McKay Brothers ».
"""

import re

KINDS = ("gateway", "computer", "mobile", "printer", "camera", "media", "nas", "iot", "unknown")

LABEL = {
    "gateway": "Box / routeur",
    "computer": "Ordinateur",
    "mobile": "Téléphone ou tablette",
    "printer": "Imprimante",
    "camera": "Caméra",
    "media": "TV / multimédia",
    "nas": "Stockage réseau",
    "iot": "Objet connecté",
    "unknown": "Appareil inconnu",
}

# (type, ports dont UN suffit). Ports SPÉCIFIQUES : passent avant le nom d'hôte.
_STRONG_PORTS: tuple[tuple[str, frozenset[int]], ...] = (
    ("printer", frozenset({9100, 631, 515})),
    ("camera", frozenset({554, 8554, 37777})),  # RTSP, Dahua
)
# Ports AMBIGUS : après le nom d'hôte (un Mac récent écoute sur 5000/7000 pour AirPlay).
_WEAK_PORTS: tuple[tuple[str, frozenset[int]], ...] = (
    ("media", frozenset({8008, 8009, 7000, 8060, 1400})),  # Chromecast, AirPlay, Roku, Sonos
    ("nas", frozenset({5000, 5001})),  # DSM Synology / QNAP
    ("computer", frozenset({445, 139, 3389, 5985, 5900, 22, 548})),
)


def _words(*patterns: str) -> re.Pattern:
    return re.compile(r"\b(?:" + "|".join(patterns) + r")\b", re.IGNORECASE)


_HOSTNAME_HINTS: tuple[tuple[str, re.Pattern], ...] = (
    ("mobile", _words("iphone", "ipad", "android", "galaxy", "redmi", "xiaomi", "poco", "pixel", "huawei", "honor", "oppo", "realme", "oneplus", "vivo", "tecno", "infinix", "nokia", "moto")),
    ("printer", _words("printer", "epson", "canon", "brother", "laserjet", "officejet", "deskjet")),
    ("camera", _words("cam", "camera", "ipcam", "hikvision", "dahua", "reolink", "ezviz")),
    ("media", _words("tv", "bravia", "roku", "chromecast", "firetv", "appletv", "sonos", "shield")),
    ("nas", _words("nas", "synology", "diskstation", "qnap")),
    ("computer", re.compile(r"^(?:desktop|laptop|pc)-|\b(?:macbook|imac|thinkpad|latitude)\b", re.IGNORECASE)),
)

_VENDOR_HINTS: tuple[tuple[str, re.Pattern], ...] = (
    ("printer", re.compile(r"^(?:brother industries|seiko epson|canon|kyocera|lexmark|xerox)\b", re.IGNORECASE)),
    ("camera", re.compile(r"^(?:hangzhou hikvision|zhejiang dahua|reolink|ezviz)\b", re.IGNORECASE)),
    ("media", re.compile(r"^(?:roku|sonos|lg electronics|tcl|hisense|vizio)\b", re.IGNORECASE)),
    ("nas", re.compile(r"^(?:synology|qnap)\b", re.IGNORECASE)),
    ("iot", re.compile(r"^(?:espressif|tuya|shelly|allterco|sonoff|itead)\b", re.IGNORECASE)),
    ("mobile", re.compile(r"^(?:beijing xiaomi|xiaomi|huawei|oneplus|guangdong oppo|vivo mobile|samsung electro-mechanics)\b", re.IGNORECASE)),
    ("computer", re.compile(r"^(?:intel corporate|dell|lenovo|hewlett|hp inc|asustek|micro-star|gigabyte|azurewave|liteon|realtek)\b", re.IGNORECASE)),
)

_OS_TYPES = {"phone": "mobile", "printer": "printer", "webcam": "camera", "media device": "media", "storage-misc": "nas", "general purpose": "computer"}


def kind(
    *,
    is_gateway: bool,
    randomized: bool,
    ports: frozenset[int] = frozenset(),
    hostname: str | None = None,
    vendor: str | None = None,
    os_type: str | None = None,
) -> str:
    if is_gateway:
        return "gateway"
    for k, wanted in _STRONG_PORTS:
        if ports & wanted:
            return k
    for k, pattern in _HOSTNAME_HINTS:
        if hostname and pattern.search(hostname.split(".")[0]):  # « iPhone.lan » -> « iPhone »
            return k
    for k, wanted in _WEAK_PORTS:
        if ports & wanted:
            return k
    for k, pattern in _VENDOR_HINTS:
        if vendor and pattern.search(vendor):
            return k
    if randomized:
        return "mobile"
    return _OS_TYPES.get((os_type or "").lower(), "unknown")
