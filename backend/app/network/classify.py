"""Type probable d'un appareil du réseau local (pur, testé sans Windows).

Couche passive seule : on ne connaît que l'adresse MAC et le rôle de passerelle. Les ports,
le fabricant et le système (Nmap, étape suivante) affineront ce premier classement.
"""

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


def kind(*, is_gateway: bool, randomized: bool) -> str:
    # La passerelle d'abord : beaucoup de box ont une MAC « administrée localement »,
    # qui n'en fait pas un téléphone.
    if is_gateway:
        return "gateway"
    if randomized:
        return "mobile"  # MAC privée : réglage par défaut d'iOS et d'Android
    return "unknown"
