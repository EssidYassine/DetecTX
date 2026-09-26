"""Base de connaissance MITRE ATT&CK embarquée (repli déterministe hors LLM).

Couvre les techniques produites par nos règles + Sigma courantes. Toute
technique inconnue retombe sur une entrée générique.
"""

TACTICS_FR = {
    "reconnaissance": "Reconnaissance",
    "resource-development": "Développement de ressources",
    "credential-access": "Accès aux identifiants",
    "execution": "Exécution",
    "persistence": "Persistance",
    "privilege-escalation": "Élévation de privilèges",
    "defense-evasion": "Contournement des défenses",
    "command-and-control": "Commande et contrôle",
    "lateral-movement": "Déplacement latéral",
    "discovery": "Découverte",
    "collection": "Collecte",
    "initial-access": "Accès initial",
    "exfiltration": "Exfiltration",
    "impact": "Impact",
}

TECHNIQUES: dict[str, dict] = {
    "T1003.001": {
        "name": "OS Credential Dumping: LSASS Memory",
        "tactic": "credential-access",
        "desc": "Extraction d'identifiants depuis la mémoire du processus LSASS (ex. Mimikatz).",
        "impact": "Vol de mots de passe/hashes/tickets permettant un déplacement latéral et une compromission du domaine.",
        "remediation": [
            "Isoler l'hôte et forcer la réinitialisation des identifiants exposés.",
            "Activer Credential Guard et la protection LSASS (RunAsPPL).",
            "Restreindre les droits de débogage (SeDebugPrivilege).",
        ],
        "commands": [
            "Get-Process lsass | Select-Object Id,Path",
            "Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' | ? Id -eq 10",
        ],
    },
    "T1003.002": {
        "name": "OS Credential Dumping: Security Account Manager",
        "tactic": "credential-access",
        "desc": "Extraction des hashes depuis la base SAM.",
        "impact": "Récupération de comptes locaux, réutilisation d'identifiants.",
        "remediation": ["Réinitialiser les comptes locaux exposés.", "Surveiller l'accès à la ruche SAM."],
        "commands": ["reg query HKLM\\SAM", "Get-WinEvent -LogName Security | ? Id -eq 4656"],
    },
    "T1059.001": {
        "name": "Command and Scripting Interpreter: PowerShell",
        "tactic": "execution",
        "desc": "Exécution de code via PowerShell, souvent encodé/obfusqué (-EncodedCommand).",
        "impact": "Exécution de charge malveillante, téléchargement de payload, contournement de contrôles.",
        "remediation": [
            "Activer Script Block Logging et Constrained Language Mode.",
            "Décoder et analyser la commande (sans l'exécuter).",
            "Bloquer PowerShell pour les utilisateurs non concernés (AppLocker/WDAC).",
        ],
        "commands": [
            "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('<b64>'))",
            "Get-WinEvent -LogName 'Microsoft-Windows-PowerShell/Operational' | ? Id -eq 4104",
        ],
    },
    "T1105": {
        "name": "Ingress Tool Transfer",
        "tactic": "command-and-control",
        "desc": "Téléchargement d'outils/charges via des binaires légitimes (certutil, bitsadmin, mshta).",
        "impact": "Introduction de malware sur l'hôte en contournant les protections.",
        "remediation": [
            "Bloquer les LOLBins non nécessaires.",
            "Inspecter le trafic sortant et l'URL contactée.",
            "Mettre l'URL/IP en liste de blocage.",
        ],
        "commands": ["Get-NetTCPConnection -State Established", "Resolve-DnsName <domaine-suspect>"],
    },
    "T1547.001": {
        "name": "Boot or Logon Autostart Execution: Registry Run Keys",
        "tactic": "persistence",
        "desc": "Persistance via les clés Run/RunOnce du registre.",
        "impact": "Ré-exécution automatique du malware à chaque démarrage/logon.",
        "remediation": [
            "Supprimer l'entrée Run malveillante après analyse.",
            "Surveiller les modifications des clés CurrentVersion\\Run.",
        ],
        "commands": [
            "reg query HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
            "reg query HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
        ],
    },
    "T1110": {
        "name": "Brute Force",
        "tactic": "credential-access",
        "desc": "Tentatives répétées d'authentification pour deviner des identifiants.",
        "impact": "Compromission de compte, accès non autorisé.",
        "remediation": [
            "Verrouiller le compte visé et vérifier l'IP source.",
            "Activer le verrouillage de compte et la MFA.",
            "Bloquer l'IP source si externe.",
        ],
        "commands": ["Get-WinEvent -LogName Security | ? Id -eq 4625 | group IpAddress"],
    },
    "T1055": {
        "name": "Process Injection",
        "tactic": "defense-evasion",
        "desc": "Injection de code dans un processus légitime pour masquer l'exécution.",
        "impact": "Exécution furtive, contournement de l'EDR/AV.",
        "remediation": ["Analyser le processus cible.", "Isoler l'hôte si confirmé."],
        "commands": ["Get-WinEvent -LogName 'Microsoft-Windows-Sysmon/Operational' | ? Id -eq 8"],
    },
    "T1036": {
        "name": "Masquerading",
        "tactic": "defense-evasion",
        "desc": "Un binaire se fait passer pour un fichier légitime (nom/chemin trompeur).",
        "impact": "Évasion des défenses et des analystes.",
        "remediation": ["Vérifier la signature et le chemin réel du binaire.", "Comparer OriginalFileName et nom du fichier."],
        "commands": ["Get-AuthenticodeSignature <chemin>"],
    },
    "T1078": {
        "name": "Valid Accounts",
        "tactic": "defense-evasion",
        "desc": "Usage de comptes valides (souvent après vol) pour se connecter.",
        "impact": "Accès légitime en apparence, difficile à détecter.",
        "remediation": ["Vérifier la provenance des connexions.", "Réinitialiser le compte si suspect, activer la MFA."],
        "commands": ["Get-WinEvent -LogName Security | ? Id -in 4624,4625"],
    },
}

_GENERIC = {
    "name": "Technique ATT&CK",
    "tactic": "execution",
    "desc": "Activité correspondant à une technique adverse connue.",
    "impact": "Compromission potentielle de l'hôte.",
    "remediation": ["Trier l'alerte : confirmer si l'activité est légitime.", "Isoler l'hôte en cas de doute."],
    "commands": ["Get-WinEvent -LogName Security -MaxEvents 50"],
}


def technique_meta(mitre: str) -> dict:
    """Nom et tactique d'une technique, SANS repli générique : une technique absente de la
    base reste non classée (tactic=None) plutôt que d'être rangée à tort en « Exécution »."""
    known = TECHNIQUES.get(mitre)
    tactic = known["tactic"] if known else None
    return {
        "id": mitre,
        "name": known["name"] if known else None,
        "tactic": tactic,
        "tactic_fr": TACTICS_FR.get(tactic) if tactic else None,
    }


def technique_info(mitre: str | None) -> dict:
    info = dict(TECHNIQUES.get(mitre or "", _GENERIC))
    info["id"] = mitre or "N/A"
    info["tactic_fr"] = TACTICS_FR.get(info["tactic"], info["tactic"])
    return info
