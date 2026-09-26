# Collecteurs DeTecTX

DeTecTX collecte les événements de l'hôte Windows **sans Wazuh**. Deux chemins.

## 🚀 Chemin rapide (démo) — PowerShell, zéro installation

Lit les journaux Windows avec `Get-WinEvent` et les pousse vers l'API. Idéal pour voir des données tout de suite.

Prérequis : backend démarré (`docker compose up`), un compte créé sur l'écran de login.
Lancer **PowerShell en administrateur** (nécessaire pour le journal `Security`) :

```powershell
cd collectors\powershell
.\collect-and-ship.ps1 -Email me@poste.local -MaxPerChannel 100
```

→ le script se connecte, collecte, et indexe les événements. Ils apparaissent alors via `GET /events` et sur le dashboard.

Relancer périodiquement (ou planifier via le Planificateur de tâches Windows) pour un flux régulier.

## 🏭 Chemin production — Sysmon + Fluent Bit → OpenSearch

Télémétrie riche et continue, en service.

### 1. Sysmon (télémétrie détaillée : process, réseau, injection, persistance)

```powershell
# Télécharger Sysmon depuis Sysinternals, puis :
sysmon64.exe -accepteula -i sysmon\sysmonconfig.xml
```

Les événements arrivent dans le canal `Microsoft-Windows-Sysmon/Operational`.

### 2. Fluent Bit (expédition vers OpenSearch)

Installer Fluent Bit **sur l'hôte Windows** (accès requis au journal d'événements), puis :

```powershell
fluent-bit.exe -c fluent-bit\fluent-bit.conf
```

> ⚠️ Avant de brancher OpenSearch, valider une fois les noms de champs produits par le plugin `winlog` (remplacer temporairement l'`OUTPUT` par `stdout`). Le filtre `modify` les aligne sur le schéma DeTecTX.

## 🛰️ Surveillance continue — Agent DeTecTX

Pour une **surveillance quasi totale et centralisée** (au-delà d'un `Get-WinEvent` ponctuel), utiliser l'agent continu :

```powershell
cd collectors\agent
.\detectx-agent.ps1 -Email me@poste.local -IntervalSec 15
```

Toutes les 15 s, il envoie à DeTecTX :
1. **Activité fichiers/dossiers** — création / modification / suppression dans `WatchPaths` (défaut : Bureau, Documents, Téléchargements, **Démarrage**, Temp) → canal `DeTecTX-FileMonitor`
2. **Événements Windows** nouveaux (System, Security, Application, PowerShell, Sysmon) — boot, logons, services… (incrémentaux)
3. **Centralisation des logs** — nouvelles lignes des fichiers `.log` d'un ou plusieurs dossiers :
   ```powershell
   .\detectx-agent.ps1 -Email me@poste.local -LogFolders "C:\Logs","D:\app\logs"
   ```

Lancer **en administrateur** pour couvrir le journal `Security`. Ctrl+C pour arrêter.

### Détecter l'*ouverture* d'un dossier/fichier (accès en lecture)
Windows n'émet pas d'événement à la simple ouverture, sauf si l'**audit d'accès aux objets** est activé (Event ID **4663**) :
```powershell
# 1. Activer l'audit d'accès aux objets (admin)
auditpol /set /subcategory:"File System" /success:enable /failure:enable
# 2. Ajouter une SACL d'audit sur le dossier à surveiller (ex. C:\Secret)
$acl = Get-Acl "C:\Secret"
$rule = New-Object System.Security.AccessControl.FileSystemAuditRule("Everyone","ReadData","ContainerInherit,ObjectInherit","None","Success")
$acl.AddAuditRule($rule); Set-Acl "C:\Secret" $acl
```
Les événements 4663 apparaîtront alors dans `Security` et seront collectés automatiquement par l'agent.

## Schéma d'un événement (index `detectx-events`)

| Champ | Description |
|---|---|
| `@timestamp` | Date de l'événement (UTC) |
| `channel` | Journal source (`Security`, `Sysmon/Operational`, …) |
| `event_id` | ID d'événement Windows |
| `provider` | Fournisseur |
| `computer` | Nom de la machine |
| `level` | Niveau (Information, Warning, Error…) |
| `record_id` | Identifiant d'enregistrement |
| `message` | Message brut |
| `raw` | Champs additionnels (non indexés) |
