"""Chasses prêtes à l'emploi : des questions d'analyste traduites en recherches d'événements.

Chaque chasse s'exprime avec les critères que les DEUX stockages savent évaluer (OpenSearch et
SQL) : journaux, identifiants d'événements, mots-clés dans le message — comme les règles du
moteur de détection. Une chasse n'est pas une alerte : elle ouvre la liste des événements
correspondants, à l'analyste de juger.
"""

from dataclasses import asdict, dataclass, field

SECURITY = "Security"
SYSTEM = "System"
POWERSHELL = "Microsoft-Windows-PowerShell/Operational"
SYSMON = "Microsoft-Windows-Sysmon/Operational"
FILEMON = "DeTecTX-FileMonitor"
DEFENDER = "Microsoft-Windows-Windows Defender/Operational"
FIREWALL = "Microsoft-Windows-Windows Firewall With Advanced Security/Firewall"
SESSIONS = "Microsoft-Windows-TerminalServices-LocalSessionManager/Operational"
BITS = "Microsoft-Windows-Bits-Client/Operational"
PNP = "Microsoft-Windows-Kernel-PnP/Configuration"
WMI = "Microsoft-Windows-WMI-Activity/Operational"


@dataclass(frozen=True)
class Hunt:
    id: str
    title: str
    question: str
    channels: tuple[str, ...]
    event_ids: tuple[int, ...]
    keywords: tuple[str, ...] = ()
    attack: str | None = None
    level: str = "medium"
    # Prérequis de collecte : « sysmon » (Sysmon installé), « admin » (agent administrateur
    # pour lire le journal Security).
    requires: tuple[str, ...] = field(default_factory=tuple)


HUNTS: tuple[Hunt, ...] = (
    Hunt("defender-threats", "Menaces Defender", "Defender a-t-il détecté un logiciel malveillant ?", (DEFENDER,), (1006, 1015, 1116, 1117, 1118), attack="T1204", level="high"),
    Hunt("defenses-off", "Défenses coupées ou modifiées", "La protection de Defender a-t-elle été désactivée ou modifiée ?", (DEFENDER,), (5001, 5007, 5010, 5012), attack="T1562.001", level="high"),
    Hunt("firewall-changes", "Pare-feu modifié", "Des règles du pare-feu ont-elles été ajoutées ou supprimées ?", (FIREWALL,), (2004, 2005, 2006, 2033, 2052, 2097, 2099), attack="T1562.004"),
    Hunt("sessions", "Ouvertures de session", "Qui a ouvert une session, et depuis où ?", (SESSIONS,), (21, 25), attack="T1021.001", level="low"),
    Hunt("bits-downloads", "Téléchargements BITS", "Des fichiers ont-ils été téléchargés en arrière-plan ?", (BITS,), (59,), ("http",), attack="T1197", level="low"),
    Hunt("usb-devices", "Supports amovibles", "Une clé USB ou un disque externe a-t-il été branché ?", (PNP,), (400,), ("USBSTOR", "SCSI\\Disk", "USB\\VID"), attack="T1091", level="low"),
    Hunt("wmi-persistence", "Persistance WMI", "Un abonnement WMI permanent a-t-il été créé ?", (WMI,), (5861,), attack="T1546.003", level="high"),
    Hunt("logon-failures", "Échecs de connexion", "Quelqu'un essaie-t-il de deviner un mot de passe ?", (SECURITY,), (4625, 4740), attack="T1110", requires=("admin",)),
    Hunt("new-accounts", "Comptes créés ou promus", "Un compte a-t-il été créé ou ajouté aux administrateurs ?", (SECURITY,), (4720, 4722, 4732), attack="T1136.001", level="high", requires=("admin",)),
    Hunt("new-services", "Services installés", "Un programme s'est-il installé comme service ?", (SYSTEM, SECURITY), (7045, 4697), attack="T1543.003", level="high"),
    Hunt("scheduled-tasks", "Tâches planifiées", "Une tâche planifiée a-t-elle été créée ou modifiée ?", (SECURITY,), (4698, 4702), attack="T1053.005", level="high", requires=("admin",)),
    Hunt("logs-cleared", "Journaux effacés", "Quelqu'un a-t-il effacé des traces ?", (SECURITY, SYSTEM), (1102, 104), attack="T1070.001", level="high"),
    Hunt(
        "ps-suspicious",
        "PowerShell suspect",
        "Du PowerShell encodé ou qui télécharge du code a-t-il tourné ?",
        (POWERSHELL,),
        (4104, 4103),
        ("-enc", "EncodedCommand", "FromBase64String", "DownloadString", "DownloadFile", "Invoke-Expression", "IEX", "Net.WebClient", "Invoke-WebRequest"),
        attack="T1059.001",
        level="high",
    ),
    Hunt("explicit-creds", "Identifiants explicites", "Des identifiants ont-ils été utilisés au nom d'un autre compte ?", (SECURITY,), (4648,), attack="T1078", requires=("admin",)),
    Hunt(
        "startup-drops",
        "Dépôts dans « Démarrage »",
        "Un fichier a-t-il été déposé pour se lancer à l'ouverture de session ?",
        (FILEMON,),
        (1, 2),
        ("\\Startup\\",),
        attack="T1547.001",
        level="high",
    ),
    Hunt(
        "temp-execution",
        "Exécution depuis Temp ou Téléchargements",
        "Un programme a-t-il été lancé depuis un dossier temporaire ?",
        (SYSMON,),
        (1,),
        ("\\AppData\\Local\\Temp\\", "\\Downloads\\", "\\Users\\Public\\"),
        attack="T1204.002",
        requires=("sysmon",),
    ),
    Hunt("lsass-access", "Accès à la mémoire de LSASS", "Un outil a-t-il tenté de lire les identifiants en mémoire ?", (SYSMON,), (10,), ("lsass.exe",), attack="T1003.001", level="high", requires=("sysmon",)),
    Hunt("run-keys", "Persistance par clés Run", "Un programme s'est-il ajouté au démarrage via le registre ?", (SYSMON,), (13,), ("\\CurrentVersion\\Run",), attack="T1547.001", level="high", requires=("sysmon",)),
    Hunt("remote-threads", "Injection de code", "Un processus a-t-il injecté du code dans un autre ?", (SYSMON,), (8,), attack="T1055", level="high", requires=("sysmon",)),
)

BY_ID = {h.id: h for h in HUNTS}


def as_dict(hunt: Hunt) -> dict:
    d = asdict(hunt)
    for key in ("channels", "event_ids", "keywords", "requires"):
        d[key] = list(d[key])
    return d
