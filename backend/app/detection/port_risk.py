"""Risque d'un port en écoute : quel service, pourquoi il intéresse un attaquant, que faire.

Le niveau de base vient d'un catalogue de services connus (sources : usages courants des
ports IANA et techniques MITRE ATT&CK associées). Il est ensuite ajusté selon l'exposition
réelle calculée par services/firewall.py :
  - non exposé (local ou bloqué par le pare-feu) -> « info » : aucun risque réseau ;
  - ouvert sur un réseau classé Public (Wi-Fi d'hôtel, de gare…) -> un cran de plus ;
  - ouvert seulement au réseau local -> un cran de moins.
Posture conservatrice : on explique et on recommande, l'utilisateur décide.
"""

from dataclasses import dataclass, field

LEVELS = ("info", "low", "medium", "high", "critical")


@dataclass(frozen=True)
class PortProfile:
    service: str
    level: str  # niveau de base si le port est ouvert au réseau
    why: str
    attack: str  # technique MITRE ATT&CK de référence
    advice: str  # correction côté application (la plus propre)


_DB = "Base de données joignable : vol ou chiffrement des données, force brute des comptes."
_DB_ADVICE = "Si seul ce poste l'utilise, la lier à 127.0.0.1 dans sa configuration."
_WEB = "Application web exposée : toute faille du serveur devient exploitable à distance."
_DEV = "Serveur de développement exposé : souvent sans durcissement, parfois sans authentification."
_DEV_ADVICE = "Démarrer le serveur avec l'hôte 127.0.0.1 (ex. « next start -H 127.0.0.1 »)."
_WIN_CORE = "Service réseau de Windows : ne pas arrêter le processus ; restreindre plutôt au réseau local."

CATALOG: dict[tuple[str, int], PortProfile] = {
    ("tcp", 21): PortProfile("FTP", "high", "Identifiants et fichiers transmis en clair.", "T1021", "Préférer SFTP ; désactiver le serveur FTP s'il n'est pas utilisé."),
    ("tcp", 22): PortProfile("SSH", "medium", "Accès shell à distance : cible de force brute.", "T1021.004", "Authentification par clé uniquement ; restreindre aux adresses de confiance."),
    ("tcp", 23): PortProfile("Telnet", "critical", "Shell à distance en clair, sans chiffrement.", "T1021", "Désactiver Telnet ; utiliser SSH."),
    ("tcp", 25): PortProfile("SMTP", "medium", "Relais de messagerie : spam, usurpation.", "T1190", "Ne pas exposer de serveur SMTP sur un poste de travail."),
    ("udp", 53): PortProfile("DNS", "medium", "Résolveur ouvert : amplification DDoS, empoisonnement.", "T1190", "Limiter le serveur DNS au poste ou au réseau local."),
    ("tcp", 80): PortProfile("HTTP", "medium", _WEB, "T1190", "Vérifier qu'un serveur web doit vraiment tourner sur ce poste."),
    ("tcp", 135): PortProfile("RPC (Endpoint Mapper)", "high", "Porte d'entrée des services RPC de Windows, historiquement exploitée (vers).", "T1210", _WIN_CORE),
    ("udp", 137): PortProfile("NetBIOS Nom", "medium", "Divulgue le nom du poste et permet l'empoisonnement NBT-NS.", "T1557.001", "Désactiver NetBIOS sur TCP/IP si inutile."),
    ("udp", 138): PortProfile("NetBIOS Datagramme", "low", "Service hérité, rarement nécessaire.", "T1557.001", "Désactiver NetBIOS sur TCP/IP si inutile."),
    ("tcp", 139): PortProfile("NetBIOS Session (SMB)", "high", "Partage de fichiers hérité : énumération, relais NTLM.", "T1021.002", _WIN_CORE),
    ("udp", 161): PortProfile("SNMP", "high", "Communauté par défaut souvent « public » : fuite de configuration.", "T1602", "Désactiver SNMP ou le limiter en v3."),
    ("tcp", 443): PortProfile("HTTPS", "medium", _WEB, "T1190", "Vérifier qu'un serveur web doit vraiment tourner sur ce poste."),
    ("tcp", 445): PortProfile("SMB", "high", "Partage de fichiers Windows : cible d'EternalBlue, de rançongiciels et de relais NTLM.", "T1021.002", _WIN_CORE),
    ("tcp", 902): PortProfile("VMware Authorization", "medium", "Console distante des machines virtuelles VMware.", "T1021", "Désactiver le partage de VM dans VMware Workstation si inutile."),
    ("tcp", 912): PortProfile("VMware Authorization", "medium", "Console distante des machines virtuelles VMware.", "T1021", "Désactiver le partage de VM dans VMware Workstation si inutile."),
    ("tcp", 1433): PortProfile("SQL Server", "high", _DB, "T1190", _DB_ADVICE),
    ("tcp", 1521): PortProfile("Oracle (listener TNS)", "high", _DB, "T1190", _DB_ADVICE),
    ("udp", 1900): PortProfile("SSDP / UPnP", "low", "Découverte d'appareils : fuite d'informations, amplification.", "T1046", "Désactiver le service « Découverte SSDP » si inutile."),
    ("tcp", 3000): PortProfile("Serveur de développement (Node.js…)", "medium", _DEV, "T1190", _DEV_ADVICE),
    ("tcp", 3306): PortProfile("MySQL", "high", _DB, "T1190", "Mettre « bind-address = 127.0.0.1 » dans my.ini si seul ce poste l'utilise."),
    ("tcp", 3389): PortProfile("Bureau à distance (RDP)", "high", "Prise de contrôle totale du poste : force brute, BlueKeep.", "T1021.001", "Désactiver le Bureau à distance ou le réserver à un VPN."),
    ("tcp", 4200): PortProfile("Serveur de développement (Angular)", "medium", _DEV, "T1190", _DEV_ADVICE),
    ("tcp", 5040): PortProfile("Service Plateforme d'appareils connectés", "low", "Service Windows de partage entre appareils.", "T1210", _WIN_CORE),
    ("udp", 5353): PortProfile("mDNS", "low", "Annonce le poste sur le réseau local.", "T1046", "Sans action nécessaire sur un réseau de confiance."),
    ("udp", 5355): PortProfile("LLMNR", "medium", "Empoisonnement LLMNR : vol de hachés NTLM (Responder).", "T1557.001", "Désactiver LLMNR par stratégie de groupe."),
    ("tcp", 5173): PortProfile("Serveur de développement (Vite)", "medium", _DEV, "T1190", _DEV_ADVICE),
    ("tcp", 5432): PortProfile("PostgreSQL", "high", _DB, "T1190", "Mettre « listen_addresses = 'localhost' » si seul ce poste l'utilise."),
    ("tcp", 5601): PortProfile("Kibana / OpenSearch Dashboards", "high", "Console d'analyse : accès aux journaux collectés.", "T1190", "Lier à 127.0.0.1 et activer l'authentification."),
    ("tcp", 5900): PortProfile("VNC", "high", "Prise de contrôle à distance, mots de passe souvent faibles.", "T1021.005", "Désactiver VNC ou le réserver à un VPN."),
    ("tcp", 5985): PortProfile("WinRM (HTTP)", "high", "Exécution de commandes PowerShell à distance.", "T1021.006", "Désactiver WinRM s'il n'est pas utilisé."),
    ("tcp", 5986): PortProfile("WinRM (HTTPS)", "high", "Exécution de commandes PowerShell à distance.", "T1021.006", "Désactiver WinRM s'il n'est pas utilisé."),
    ("tcp", 6379): PortProfile("Redis", "critical", "Souvent sans authentification : exécution de code à distance possible.", "T1190", "Lier à 127.0.0.1 et exiger un mot de passe (requirepass)."),
    ("tcp", 7680): PortProfile("Optimisation de la distribution", "low", "Partage des mises à jour Windows entre postes.", "T1210", "Limiter l'optimisation de distribution au réseau local dans les paramètres Windows Update."),
    ("tcp", 8000): PortProfile("Serveur web / API", "medium", _WEB, "T1190", _DEV_ADVICE),
    ("tcp", 8080): PortProfile("HTTP alternatif", "medium", _WEB, "T1190", "Identifier l'application (souvent une console d'administration) et la lier à 127.0.0.1."),
    ("tcp", 8443): PortProfile("HTTPS alternatif", "medium", _WEB, "T1190", "Identifier l'application et la lier à 127.0.0.1 si elle est locale."),
    ("tcp", 8888): PortProfile("Jupyter / serveur web", "high", "Notebook Jupyter : exécution de code à distance si le jeton fuit.", "T1190", "Lier à 127.0.0.1."),
    ("tcp", 9200): PortProfile("Elasticsearch / OpenSearch", "high", _DB, "T1190", "Lier à 127.0.0.1 et activer la sécurité."),
    ("tcp", 11211): PortProfile("Memcached", "high", "Sans authentification : fuite de données, amplification DDoS.", "T1190", "Lier à 127.0.0.1."),
    ("tcp", 27017): PortProfile("MongoDB", "high", _DB, "T1190", "Mettre « bindIp: 127.0.0.1 » si seul ce poste l'utilise."),
    ("tcp", 33060): PortProfile("MySQL X Protocol", "high", _DB, "T1190", "Mettre « mysqlx_bind_address = 127.0.0.1 » dans my.ini."),
}

# Processus Windows qui écoutent sur les ports RPC dynamiques (49152-65535) par conception.
_WINDOWS_RPC = {"lsass.exe", "wininit.exe", "services.exe", "spoolsv.exe", "svchost.exe"}

_UNKNOWN = PortProfile(
    "Service non répertorié",
    "medium",
    "Un programme accepte des connexions depuis le réseau : vérifier qu'il en a besoin.",
    "T1190",
    "Identifier le programme ; s'il ne sert qu'à ce poste, le configurer pour écouter sur 127.0.0.1.",
)


def profile_for(proto: str, port: int, process: str | None) -> PortProfile:
    known = CATALOG.get((proto, port))
    if known:
        return known
    if 49152 <= port <= 65535 and (process or "").lower() in _WINDOWS_RPC:
        return PortProfile("RPC dynamique de Windows", "low", "Point de terminaison RPC d'un service Windows.", "T1210", _WIN_CORE)
    return _UNKNOWN


@dataclass(frozen=True)
class Risk:
    level: str
    service: str
    why: str
    attack: str
    advice: list[str] = field(default_factory=list)


def _shift(level: str, delta: int) -> str:
    i = max(0, min(len(LEVELS) - 1, LEVELS.index(level) + delta))
    return LEVELS[i]


def assess(proto: str, port: int, process: str | None, verdict: str, scope: str | None, public: bool) -> Risk:
    """verdict : open | blocked | local | unknown ; scope : any | local_subnet | restricted | None."""
    base = profile_for(proto, port, process)
    if base is _UNKNOWN and process:  # un nom de programme parle plus que « non répertorié »
        base = PortProfile(process, base.level, base.why, base.attack, base.advice)
    if verdict in ("local", "blocked"):
        return Risk("info", base.service, base.why, base.attack, [])
    level = base.level
    advice = [base.advice]
    if verdict == "open":
        if scope in ("local_subnet", "restricted"):  # pas joignable par « n'importe qui »
            level = _shift(level, -1)
        elif scope == "any" and public:
            level = _shift(level, +1)
            advice.append("Le réseau actuel est classé Public : la règle qui ouvre ce port ne devrait pas s'appliquer au profil Public.")
    else:  # unknown : on ne majore pas, mais on ne rassure pas non plus
        advice.append("Exposition non déterminée avec certitude : vérifier la règle dans « Pare-feu Windows Defender ».")
    return Risk(level, base.service, base.why, base.attack, advice)
