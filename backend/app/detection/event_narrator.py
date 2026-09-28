"""Une phrase lisible par événement : « Connecté au Wi-Fi « Maison » » plutôt que « 8001 ».

Les gabarits utilisent les noms de champs RÉELS des journaux (relevés sur un Windows 11) ;
si un champ obligatoire manque, on ne fabrique rien : repli sur la 1re ligne du message d'origine.
Un segment entre crochets est facultatif : « [ depuis {IpAddress}] » disparaît si le champ est vide.
Aucune interprétation ici (pas de verdict) : seulement de la mise en forme.
"""

import re

from app.detection.event_catalog import family

TEMPLATES: dict[tuple[str, int], str] = {
    # Sessions & comptes
    ("Security", 4624): "Connexion de {TargetUserName} (type {LogonType})",
    ("Security", 4625): "Échec de connexion pour {TargetUserName}[ depuis {IpAddress}]",
    ("Security", 4648): "{SubjectUserName} utilise les identifiants de {TargetUserName}",
    ("Security", 4720): "Compte créé : {TargetUserName}",
    ("Security", 4732): "{MemberName} ajouté au groupe {TargetUserName}",
    ("Security", 4698): "Tâche planifiée créée : {TaskName}",
    ("Security", 1102): "Journal de sécurité effacé par {SubjectUserName}",
    ("Sessions", 21): "Session ouverte : {User}[ (source {Address})]",
    ("Sessions", 22): "Bureau démarré pour {User}",
    ("Sessions", 23): "Session fermée : {User}",
    ("Sessions", 24): "Session déconnectée : {User}",
    ("Sessions", 25): "Reconnexion de {User}[ (source {Address})]",
    # Défense
    ("Defender", 1006): "Logiciel malveillant trouvé : {Threat Name}",
    ("Defender", 1116): "Menace détectée : {Threat Name}[ — {Path}]",
    ("Defender", 1117): "Action Defender sur {Threat Name} : {Action Name}",
    ("Defender", 5007): "Réglage Defender modifié : {New Value}",
    ("Firewall", 2004): "Règle de pare-feu ajoutée : {RuleName}[ ({ApplicationPath})]",
    ("Firewall", 2097): "Règle de pare-feu ajoutée : {RuleName}[ ({ApplicationPath})]",
    ("Firewall", 2005): "Règle de pare-feu modifiée : {RuleName}",
    ("Firewall", 2099): "Règle de pare-feu modifiée : {RuleName}",
    ("Firewall", 2006): "Règle de pare-feu supprimée : {RuleName}",
    ("Firewall", 2052): "Règle de pare-feu supprimée : {RuleName}[ par {ModifyingApplication}]",
    ("CodeIntegrity", 3033): "Signature non conforme : {FileNameBuffer}",
    ("CodeIntegrity", 3077): "Chargement bloqué : {FileNameBuffer}",
    # Exécution
    ("PowerShell", 4104): "Script PowerShell : {ScriptBlockText}",
    ("WMI", 5860): "Abonnement WMI temporaire : {Query}",
    ("TaskScheduler", 106): "Tâche planifiée enregistrée : {TaskName}",
    ("TaskScheduler", 141): "Tâche planifiée supprimée : {TaskName}",
    ("Sysmon", 1): "{Image} lancé par {ParentImage}",
    ("Sysmon", 3): "{Image} → {DestinationIp}:{DestinationPort}",
    ("Sysmon", 8): "{SourceImage} injecte du code dans {TargetImage}",
    ("Sysmon", 10): "{SourceImage} accède à la mémoire de {TargetImage}",
    ("Sysmon", 11): "Fichier créé : {TargetFilename}",
    ("Sysmon", 13): "Registre modifié : {TargetObject}",
    ("Sysmon", 22): "{Image} résout {QueryName}",
    # Réseau & périphériques
    ("WLAN", 8001): "Connecté au Wi-Fi « {SSID} »",
    ("WLAN", 8003): "Déconnecté du Wi-Fi « {SSID} »",
    ("NetworkProfile", 10000): "Réseau « {Name} » connecté",
    ("NetworkProfile", 10001): "Réseau « {Name} » déconnecté",
    ("PnP", 400): "Périphérique configuré : {DeviceInstanceId}",
    ("PnP", 410): "Périphérique démarré : {DeviceInstanceId}",
    ("PnP", 420): "Périphérique retiré : {DeviceInstanceId}",
    ("BITS", 3): "Transfert BITS créé : {jobTitle}[ ({processPath})]",
    ("BITS", 59): "Téléchargement BITS : {url}",
    ("BITS", 60): "Téléchargement BITS terminé : {url}",
    # Système
    ("System", 7045): "Service installé : {ServiceName}[ — {ImagePath}]",
    ("System", 7040): "Démarrage du service « {param1} » : {param2} → {param3}",
    ("System", 7036): "Service « {param1} » : {param2}",
    # Fichiers (agent DeTecTX)
    ("FileMonitor", 1): "Fichier créé : {Path}",
    ("FileMonitor", 2): "Fichier modifié : {Path}",
    ("FileMonitor", 3): "Fichier supprimé : {Path}",
}

_FIELD = re.compile(r"{([^{}]+)}")
_OPTIONAL = re.compile(r"\[([^\[\]]*)\]")
_MAX_VALUE = 90
# Champs contenant un chemin : on garde la FIN (le nom du fichier est le plus parlant).
_PATH_FIELDS = {
    "ApplicationPath", "ImagePath", "Path", "TargetFilename", "FileNameBuffer", "Image", "ParentImage",
    "SourceImage", "TargetImage", "processPath", "ModifyingApplication", "TargetObject", "DeviceInstanceId",
}
_EXE_PREFIX = re.compile(r'^"?[A-Za-z]:\\(?:[^\\"]+\\)+')  # « C:\Dossier\…\ » devant l'exécutable
_NT_VOLUME = re.compile(r"^\\Device\\HarddiskVolume\d+(?=\\)", re.IGNORECASE)  # chemin noyau (CodeIntegrity)


def _shorten(value: str, *, path: bool = False) -> str:
    value = " ".join(value.split())  # une ligne, espaces normalisés
    if path:
        value = _NT_VOLUME.sub("", value)  # « \Device\HarddiskVolume3\Program Files\… » -> « \Program Files\… »
    if len(value) <= _MAX_VALUE:
        return value
    if path:
        return "…" + value[-(_MAX_VALUE - 1) :]
    return value[: _MAX_VALUE - 1] + "…"


def _first_line(message: str | None) -> str | None:
    if not message:
        return None
    line = next((ln.strip() for ln in message.splitlines() if ln.strip()), "")
    return _shorten(line) if line else None


def summarize(channel: str | None, event_id: int | None, fields: dict | None, message: str | None) -> str | None:
    fam = family(channel)
    fields = fields or {}
    if fam == "PowerShell" and event_id in (400, 403, 600):
        # Journal « Windows PowerShell » : données sans nom, la commande est dans le texte.
        found = re.search(r"HostApplication=([^\r\n]+)", message or "") or re.search(
            r"HostApplication=([^\r\n]+)", " ".join(str(v) for v in fields.values())
        )
        if found:
            verb = "PowerShell démarré" if event_id == 400 else "PowerShell arrêté" if event_id == 403 else "Fournisseur PowerShell"
            command = _EXE_PREFIX.sub("", found.group(1).strip())  # « powershell.exe -… » sans le dossier
            return f"{verb} : {_shorten(command)}"
    template = TEMPLATES.get((fam, event_id)) if event_id is not None else None
    if template:
        values = {n: _value(fields, n) for n in _FIELD.findall(template)}
        # Segment facultatif : gardé (sans crochets) seulement si tous ses champs sont renseignés.
        template = _OPTIONAL.sub(lambda m: m.group(1) if all(values[n] for n in _FIELD.findall(m.group(1))) else "", template)
        if all(values[n] for n in _FIELD.findall(template)):
            return _FIELD.sub(lambda m: _shorten(values[m.group(1)], path=m.group(1) in _PATH_FIELDS), template)
    return _first_line(message)


def _value(fields: dict, name: str) -> str:
    """Valeur exploitable d'un champ ; « - » et « %%1 » (valeurs vides de Windows) comptent pour rien."""
    value = str(fields.get(name) or "").strip()
    return "" if value in ("-", "%%1") else value
