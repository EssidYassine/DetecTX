"""Catalogue des identifiants d'événements Windows utiles à l'analyste.

Pour chaque (famille de journal, Event ID) : ce qui s'est passé, pourquoi c'est intéressant
pour la sécurité, et la technique MITRE ATT&CK associée le cas échéant. Sert au lecteur
d'événements du dashboard : l'analyste lit « Nouveau service installé » au lieu de « 7045 ».

Sources : documentation Microsoft des événements d'audit Windows, documentation Sysmon
(Sysinternals), correspondances ATT&CK usuelles. Niveau = intérêt pour l'analyste, pas une
alerte : la détection reste le rôle du moteur Sigma.
"""

from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class EventKnowledge:
    title: str
    what: str
    why: str
    level: str  # info | low | medium | high
    attack: str | None = None


# Journaux « Microsoft-Windows-… » -> famille courte (les Event IDs ne sont uniques que par famille).
_FAMILIES = (
    ("sysmon", "Sysmon"),
    ("powershell", "PowerShell"),
    ("windows defender", "Defender"),
    ("windows firewall", "Firewall"),
    ("terminalservices-localsessionmanager", "Sessions"),
    ("bits-client", "BITS"),
    ("kernel-pnp", "PnP"),
    ("wlan-autoconfig", "WLAN"),
    ("networkprofile", "NetworkProfile"),
    ("codeintegrity", "CodeIntegrity"),
    ("wmi-activity", "WMI"),
    ("taskscheduler", "TaskScheduler"),
    ("detectx-filemonitor", "FileMonitor"),
    ("detectx-logfile", "LogFile"),
)


def family(channel: str | None) -> str:
    """Famille d'un journal : Security, System, Application, PowerShell, Sysmon, Defender…"""
    c = (channel or "").lower()
    for needle, name in _FAMILIES:
        if needle in c:
            return name
    for name in ("Security", "System", "Application"):
        if c == name.lower():
            return name
    return channel or ""


K = EventKnowledge
CATALOG: dict[tuple[str, int], EventKnowledge] = {
    # ── Security
    ("Security", 1102): K("Journal de sécurité effacé", "Quelqu'un a vidé le journal Security.", "Geste typique d'un attaquant qui efface ses traces.", "high", "T1070.001"),
    ("Security", 4624): K("Ouverture de session réussie", "Un compte s'est authentifié sur le poste.", "Le type de session compte : 3 = réseau, 10 = bureau à distance. Une session inattendue peut signaler un compte volé.", "low", "T1078"),
    ("Security", 4625): K("Échec d'ouverture de session", "Une authentification a échoué (mauvais mot de passe, compte inconnu…).", "Des échecs répétés en peu de temps trahissent une attaque par force brute.", "medium", "T1110"),
    ("Security", 4634): K("Fermeture de session", "Une session s'est terminée.", "Utile pour reconstituer la durée d'une session.", "info"),
    ("Security", 4647): K("Déconnexion initiée par l'utilisateur", "L'utilisateur s'est déconnecté.", "Complète la chronologie des sessions.", "info"),
    ("Security", 4648): K("Connexion avec des identifiants explicites", "Un programme a utilisé d'autres identifiants (runas, connexion réseau).", "Fréquent lors d'un mouvement latéral avec des identifiants volés.", "medium", "T1078"),
    ("Security", 4657): K("Valeur de registre modifiée", "Une valeur de registre auditée a changé.", "Le registre sert à la persistance et à la désactivation des défenses.", "medium", "T1112"),
    ("Security", 4663): K("Accès à un objet", "Un fichier ou dossier audité a été lu ou modifié.", "Permet de savoir qui a ouvert un dossier sensible (nécessite l'audit d'accès aux objets).", "low", "T1005"),
    ("Security", 4672): K("Privilèges spéciaux attribués", "Une session administrateur (ou équivalente) a été ouverte.", "À surveiller hors des horaires ou des comptes habituels.", "low", "T1078"),
    ("Security", 4688): K("Création de processus", "Un programme a été lancé (audit des processus activé).", "Base de la chasse : qui a lancé quoi, avec quelle ligne de commande.", "low", "T1059"),
    ("Security", 4697): K("Service installé", "Un service a été installé sur le système.", "Méthode classique de persistance et d'exécution avec privilèges SYSTEM.", "high", "T1543.003"),
    ("Security", 4698): K("Tâche planifiée créée", "Une tâche planifiée a été ajoutée.", "Mécanisme de persistance très utilisé par les logiciels malveillants.", "high", "T1053.005"),
    ("Security", 4699): K("Tâche planifiée supprimée", "Une tâche planifiée a été retirée.", "Peut accompagner le nettoyage de traces après une attaque.", "low", "T1053.005"),
    ("Security", 4702): K("Tâche planifiée modifiée", "Une tâche planifiée existante a été changée.", "Détourner une tâche légitime est plus discret que d'en créer une.", "medium", "T1053.005"),
    ("Security", 4719): K("Stratégie d'audit modifiée", "La politique de journalisation a été changée.", "Désactiver l'audit rend l'attaquant invisible.", "high", "T1562.002"),
    ("Security", 4720): K("Compte utilisateur créé", "Un nouveau compte local a été créé.", "Création de compte = persistance possible.", "high", "T1136.001"),
    ("Security", 4722): K("Compte utilisateur activé", "Un compte désactivé a été réactivé.", "Réactiver un compte dormant est une technique de persistance discrète.", "medium", "T1098"),
    ("Security", 4724): K("Mot de passe réinitialisé", "Le mot de passe d'un compte a été réinitialisé.", "Prise de contrôle d'un compte existant.", "medium", "T1098"),
    ("Security", 4732): K("Membre ajouté à un groupe local", "Un compte a été ajouté à un groupe local (souvent Administrateurs).", "Élévation de privilèges persistante.", "high", "T1098"),
    ("Security", 4740): K("Compte verrouillé", "Un compte a été verrouillé après trop d'échecs.", "Conséquence fréquente d'une force brute.", "medium", "T1110"),
    ("Security", 4946): K("Règle ajoutée au pare-feu", "Une exception a été ajoutée au pare-feu Windows.", "Un attaquant peut ouvrir un port pour son accès distant.", "medium", "T1562.004"),
    ("Security", 4947): K("Règle du pare-feu modifiée", "Une exception du pare-feu Windows a été modifiée.", "Affaiblir une règle existante est discret.", "medium", "T1562.004"),
    # ── System
    ("System", 16): K("Historique d'une ruche de registre réinitialisé", "Windows a remis à zéro l'historique d'accès d'une ruche de registre.", "Bruit normal de Windows, sans lien avec la sécurité.", "info"),
    ("System", 104): K("Journal système effacé", "Un journal d'événements a été vidé.", "Effacement de traces.", "high", "T1070.001"),
    ("System", 1074): K("Arrêt ou redémarrage demandé", "Un utilisateur ou un programme a demandé l'arrêt du poste.", "Contexte : explique une coupure de la collecte.", "info"),
    ("System", 6005): K("Démarrage du journal d'événements", "Le service de journalisation a démarré (démarrage du poste).", "Repère de démarrage dans la chronologie.", "info"),
    ("System", 6006): K("Arrêt du journal d'événements", "Le service de journalisation s'est arrêté proprement (arrêt du poste).", "Repère d'arrêt dans la chronologie.", "info"),
    ("System", 6008): K("Arrêt inattendu", "Le système s'est arrêté sans arrêt propre.", "Plantage, coupure de courant — ou arrêt forcé.", "low"),
    ("System", 7036): K("Service démarré ou arrêté", "Un service a changé d'état.", "Surtout utile si un service de sécurité s'arrête.", "info"),
    ("System", 7040): K("Démarrage d'un service modifié", "Le type de démarrage d'un service a changé.", "Désactiver un service de sécurité au démarrage est une technique d'évasion.", "low", "T1562.001"),
    ("System", 7045): K("Nouveau service installé", "Un service a été installé.", "Persistance et exécution SYSTEM ; typique de PsExec et de nombreux malwares.", "high", "T1543.003"),
    ("System", 10016): K("Autorisation DCOM manquante", "Un composant DCOM a été appelé sans l'autorisation attendue.", "Bruit connu de Windows, généralement sans incidence.", "info"),
    # ── Application
    ("Application", 1000): K("Plantage d'application", "Un programme s'est arrêté brutalement.", "Des plantages répétés d'un même programme peuvent révéler une tentative d'exploitation.", "low", "T1203"),
    ("Application", 1001): K("Rapport d'erreurs Windows", "Windows a préparé un rapport de plantage.", "Complète l'événement 1000.", "info"),
    ("Application", 1002): K("Application bloquée", "Un programme ne répondait plus.", "Généralement sans lien avec la sécurité.", "info"),
    ("Application", 16384): K("Redémarrage planifié de la protection logicielle", "Le service de licences Windows a planifié son redémarrage.", "Bruit normal de Windows, sans lien avec la sécurité.", "info"),
    ("Application", 11707): K("Logiciel installé", "Windows Installer a installé un produit.", "Savoir ce qui a été installé et quand.", "low"),
    ("Application", 11724): K("Logiciel désinstallé", "Windows Installer a retiré un produit.", "Un outil de sécurité désinstallé mérite une vérification.", "low"),
    # ── PowerShell
    ("PowerShell", 4103): K("Exécution de commande PowerShell", "Journalisation de module : une commande a été exécutée.", "Montre ce qui a réellement été exécuté.", "low", "T1059.001"),
    ("PowerShell", 4104): K("Bloc de script PowerShell", "Le contenu d'un script PowerShell a été journalisé.", "Révèle le code exécuté même obfusqué (Base64, téléchargement, IEX).", "medium", "T1059.001"),
    ("PowerShell", 40961): K("Démarrage de la console PowerShell", "Une console PowerShell s'est ouverte.", "Contexte d'exécution.", "info"),
    ("PowerShell", 40962): K("Console PowerShell prête", "La console PowerShell a fini de démarrer.", "Contexte d'exécution.", "info"),
    ("PowerShell", 53504): K("Canal IPC PowerShell ouvert", "PowerShell écoute pour le débogage entre processus.", "Événement technique, normalement sans incidence.", "info"),
    # ── Sysmon
    ("Sysmon", 1): K("Processus créé", "Un programme a été lancé (ligne de commande, parent, hachage).", "Événement central de la chasse : chaîne parent → enfant, commandes suspectes.", "low", "T1059"),
    ("Sysmon", 2): K("Date de fichier modifiée", "Un processus a changé la date de création d'un fichier.", "« Timestomping » : maquiller l'âge d'un fichier malveillant.", "medium", "T1070.006"),
    ("Sysmon", 3): K("Connexion réseau", "Un processus a ouvert une connexion réseau.", "Relie un programme à ses destinations (C2, exfiltration).", "low", "T1071"),
    ("Sysmon", 5): K("Processus terminé", "Un programme s'est arrêté.", "Complète la durée de vie d'un processus.", "info"),
    ("Sysmon", 6): K("Pilote chargé", "Un pilote noyau a été chargé.", "Un pilote non signé ou vulnérable peut donner le contrôle du noyau.", "medium", "T1068"),
    ("Sysmon", 7): K("Bibliothèque chargée", "Un processus a chargé une DLL.", "Détournement de DLL, chargement depuis un dossier inhabituel.", "low", "T1574.002"),
    ("Sysmon", 8): K("Thread distant créé", "Un processus a créé un thread dans un autre processus.", "Signature classique de l'injection de code.", "high", "T1055"),
    ("Sysmon", 10): K("Accès à un processus", "Un processus a ouvert la mémoire d'un autre.", "Vers lsass.exe : vol d'identifiants (Mimikatz).", "medium", "T1003.001"),
    ("Sysmon", 11): K("Fichier créé", "Un fichier a été créé ou écrasé.", "Dépôt d'outils, charges téléchargées.", "low", "T1105"),
    ("Sysmon", 12): K("Clé de registre créée ou supprimée", "Une clé de registre a été créée ou supprimée.", "Persistance et configuration malveillante.", "low", "T1112"),
    ("Sysmon", 13): K("Valeur de registre définie", "Une valeur de registre a été écrite.", "Clés Run/RunOnce : démarrage automatique d'un programme.", "medium", "T1547.001"),
    ("Sysmon", 15): K("Flux de données alternatif créé", "Un flux ADS a été écrit sur un fichier.", "Cacher des données derrière un fichier anodin.", "medium", "T1564.004"),
    ("Sysmon", 22): K("Requête DNS", "Un processus a résolu un nom de domaine.", "Domaines de C2, DGA, exfiltration par DNS.", "low", "T1071.004"),
    ("Sysmon", 23): K("Fichier supprimé (archivé)", "Un fichier a été supprimé et conservé par Sysmon.", "Récupérer un outil effacé par l'attaquant.", "low", "T1070.004"),
    ("Sysmon", 25): K("Altération de processus", "L'image d'un processus a été modifiée en mémoire.", "Process hollowing / herpaderping.", "high", "T1055.012"),
    ("Sysmon", 26): K("Fichier supprimé", "Un fichier a été supprimé.", "Nettoyage de traces.", "low", "T1070.004"),
    ("PowerShell", 400): K("Moteur PowerShell démarré", "Une session PowerShell a démarré (la ligne de commande est dans le message).", "Révèle les commandes lancées, y compris en PowerShell 2 (sans journalisation des scripts).", "low", "T1059.001"),
    ("PowerShell", 403): K("Moteur PowerShell arrêté", "Une session PowerShell s'est terminée.", "Donne la durée d'une session PowerShell.", "info"),
    # ── Windows Defender
    ("Defender", 1006): K("Logiciel malveillant détecté (analyse)", "Une analyse Defender a trouvé un logiciel malveillant ou indésirable.", "Menace présente sur le poste.", "high", "T1204"),
    ("Defender", 1015): K("Comportement suspect détecté", "Defender a détecté un comportement suspect.", "Signal comportemental : à examiner rapidement.", "high"),
    ("Defender", 1116): K("Menace détectée", "La protection en temps réel a détecté une menace.", "Un fichier ou un processus malveillant a été vu sur le poste.", "high", "T1204"),
    ("Defender", 1117): K("Action contre une menace", "Defender a mis en quarantaine, supprimé ou autorisé une menace.", "Vérifier que l'action a réussi.", "medium"),
    ("Defender", 1118): K("Échec de l'action contre une menace", "Defender n'a pas réussi à neutraliser une menace.", "La menace est peut-être toujours active.", "high"),
    ("Defender", 5001): K("Protection en temps réel désactivée", "La protection en temps réel de Defender a été coupée.", "Premier geste d'un attaquant avant de déposer ses outils.", "high", "T1562.001"),
    ("Defender", 5007): K("Configuration de Defender modifiée", "Un paramètre de Defender a changé (exclusions, protections…).", "Une exclusion ajoutée peut cacher un logiciel malveillant.", "medium", "T1562.001"),
    ("Defender", 5010): K("Analyse antispyware désactivée", "Une protection de Defender a été désactivée.", "Affaiblit la défense du poste.", "high", "T1562.001"),
    ("Defender", 5012): K("Analyse antivirus désactivée", "L'analyse antivirus de Defender a été désactivée.", "Affaiblit la défense du poste.", "high", "T1562.001"),
    # ── Pare-feu Windows
    ("Firewall", 2004): K("Règle ajoutée au pare-feu", "Une règle a été ajoutée au pare-feu Windows.", "Un programme peut s'ouvrir un accès entrant.", "medium", "T1562.004"),
    ("Firewall", 2005): K("Règle du pare-feu modifiée", "Une règle existante du pare-feu a changé.", "Affaiblir une règle est plus discret qu'en créer une.", "medium", "T1562.004"),
    ("Firewall", 2006): K("Règle supprimée du pare-feu", "Une règle du pare-feu a été supprimée.", "Peut retirer une protection.", "low", "T1562.004"),
    ("Firewall", 2033): K("Toutes les règles du pare-feu supprimées", "L'ensemble des règles a été effacé.", "Neutralise le pare-feu d'un coup.", "high", "T1562.004"),
    ("Firewall", 2097): K("Règle ajoutée au pare-feu", "Une règle a été ajoutée au pare-feu Windows.", "Un programme peut s'ouvrir un accès entrant.", "medium", "T1562.004"),
    ("Firewall", 2099): K("Règle du pare-feu modifiée", "Une règle existante du pare-feu a changé.", "Affaiblir une règle est plus discret qu'en créer une.", "medium", "T1562.004"),
    # ── Sessions (bureau à distance et locales)
    ("Sessions", 21): K("Ouverture de session", "Un utilisateur a ouvert une session (locale ou à distance).", "Depuis une adresse distante : accès par bureau à distance.", "low", "T1021.001"),
    ("Sessions", 23): K("Fermeture de session", "Un utilisateur a fermé sa session.", "Chronologie des sessions.", "info"),
    ("Sessions", 24): K("Session déconnectée", "Une session a été déconnectée sans être fermée.", "Chronologie des sessions.", "info"),
    ("Sessions", 25): K("Reconnexion à une session", "Un utilisateur s'est reconnecté à une session existante.", "Depuis une adresse distante : accès par bureau à distance.", "low", "T1021.001"),
    # ── BITS (transferts en arrière-plan)
    ("BITS", 3): K("Tâche de transfert BITS créée", "Un programme a créé un transfert en arrière-plan.", "BITS est détourné pour télécharger des charges discrètement.", "low", "T1197"),
    ("BITS", 59): K("Téléchargement BITS démarré", "Un transfert BITS a commencé (l'URL est dans les champs).", "Vérifier l'URL : les logiciels malveillants s'en servent pour se télécharger.", "low", "T1197"),
    ("BITS", 60): K("Téléchargement BITS terminé", "Un transfert BITS s'est terminé.", "Complète l'événement 59.", "info", "T1197"),
    # ── Périphériques
    ("PnP", 400): K("Périphérique configuré", "Windows a installé ou configuré un périphérique (clé USB, disque, carte…).", "Un support amovible peut servir à introduire ou exfiltrer des données.", "low", "T1091"),
    ("PnP", 410): K("Périphérique démarré", "Un périphérique a été démarré par Windows.", "Complète la chronologie des branchements.", "info"),
    ("PnP", 420): K("Périphérique supprimé", "Un périphérique a été retiré de la configuration.", "Chronologie des branchements.", "info"),
    # ── Réseau
    ("WLAN", 8001): K("Connexion Wi-Fi", "Le poste s'est connecté à un réseau Wi-Fi.", "Un réseau public expose davantage le poste.", "info"),
    ("WLAN", 8003): K("Déconnexion Wi-Fi", "Le poste s'est déconnecté d'un réseau Wi-Fi.", "Chronologie réseau.", "info"),
    ("NetworkProfile", 10000): K("Réseau connecté", "Le poste a rejoint un réseau (avec sa catégorie : public, privé…).", "La catégorie décide des règles du pare-feu appliquées.", "info"),
    ("NetworkProfile", 10001): K("Réseau déconnecté", "Le poste a quitté un réseau.", "Chronologie réseau.", "info"),
    # ── Intégrité du code
    ("CodeIntegrity", 3033): K("Code non conforme à la signature", "Un binaire ne respectait pas les exigences de signature.", "Pilote ou DLL non signé : possible code malveillant.", "medium", "T1553"),
    ("CodeIntegrity", 3077): K("Chargement de code bloqué", "Windows a empêché le chargement d'un fichier.", "Une tentative d'exécution a été stoppée : à identifier.", "medium", "T1553"),
    # ── WMI
    ("WMI", 5860): K("Abonnement WMI temporaire", "Un consommateur d'événements WMI temporaire a été enregistré.", "WMI permet d'exécuter du code sur événement.", "medium", "T1546.003"),
    ("WMI", 5861): K("Abonnement WMI permanent", "Un consommateur d'événements WMI permanent a été enregistré.", "Technique de persistance furtive, sans fichier au démarrage.", "high", "T1546.003"),
    # ── Planificateur de tâches
    ("TaskScheduler", 106): K("Tâche planifiée enregistrée", "Une tâche planifiée a été créée.", "Persistance classique.", "medium", "T1053.005"),
    ("TaskScheduler", 140): K("Tâche planifiée modifiée", "Une tâche planifiée a été mise à jour.", "Détourner une tâche légitime est discret.", "medium", "T1053.005"),
    ("TaskScheduler", 141): K("Tâche planifiée supprimée", "Une tâche planifiée a été retirée.", "Peut accompagner un nettoyage de traces.", "low", "T1053.005"),
    # ── Agent DeTecTX
    ("FileMonitor", 1): K("Fichier créé", "L'agent DeTecTX a vu apparaître un fichier dans un dossier surveillé.", "Dans « Démarrage » : programme lancé à chaque ouverture de session.", "low", "T1547.001"),
    ("FileMonitor", 2): K("Fichier modifié", "Un fichier surveillé a changé.", "Contexte d'activité.", "info"),
    ("FileMonitor", 3): K("Fichier supprimé", "Un fichier surveillé a disparu.", "Suppression massive : possible rançongiciel ou nettoyage.", "low", "T1070.004"),
}


# Identifiants partagés par plusieurs fournisseurs : la fiche ne vaut que pour le fournisseur
# attendu. Ex. : l'ID 1000 du journal Application est un plantage pour « Application Error »,
# mais VMware (vmauthd) y écrit ses messages d'information sous le même ID.
PROVIDERS: dict[tuple[str, int], str] = {
    ("Application", 1000): "Application Error",
    ("Application", 1001): "Windows Error Reporting",
    ("Application", 1002): "Application Hang",
    ("Application", 11707): "MsiInstaller",
    ("Application", 11724): "MsiInstaller",
    ("Application", 16384): "Microsoft-Windows-Security-SPP",
}


def lookup(channel: str | None, event_id: int | None, provider: str | None = None) -> K | None:
    """Fiche du catalogue ; None si l'ID est inconnu ou émis par un autre fournisseur que prévu
    (fournisseur absent = on garde la fiche, faute de mieux)."""
    if event_id is None:
        return None
    key = (family(channel), event_id)
    known = CATALOG.get(key)
    expected = PROVIDERS.get(key)
    if known and expected and provider and provider.lower() != expected.lower():
        return None
    return known


def describe(channel: str | None, event_id: int | None, provider: str | None = None) -> dict | None:
    known = lookup(channel, event_id, provider)
    return asdict(known) if known else None


# ─────────────────────────────── thèmes du relief
@dataclass(frozen=True)
class Theme:
    key: str
    label: str
    families: tuple[str, ...]


# De l'avant vers l'arrière du relief : les thèmes rares (et graves) devant, le bruit derrière.
THEMES: tuple[Theme, ...] = (
    Theme("sessions", "Sessions & comptes", ("Security", "Sessions")),
    Theme("defense", "Défense", ("Defender", "Firewall", "CodeIntegrity")),
    Theme("execution", "Exécution", ("PowerShell", "Sysmon", "WMI", "TaskScheduler")),
    Theme("network", "Réseau & périphériques", ("WLAN", "NetworkProfile", "PnP", "BITS")),
    Theme("system", "Système", ("System",)),
    Theme("apps", "Applications & fichiers", ("Application", "FileMonitor", "LogFile")),
)
_THEME_OF = {fam: t.key for t in THEMES for fam in t.families}


def theme_of(channel: str | None) -> str:
    """Thème d'un journal ; les journaux inconnus rejoignent « Applications & fichiers »."""
    return _THEME_OF.get(family(channel), "apps")
