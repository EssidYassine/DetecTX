<#
.SYNOPSIS
  Collecteur rapide DeTecTX - lit les journaux Windows (Get-WinEvent) et les
  envoie au backend (/events/ingest). Aucun agent a installer.

.DESCRIPTION
  Chemin de demarrage rapide (demo). Pour la production, preferer Sysmon +
  Fluent Bit (voir collectors/README.md). Lancer PowerShell EN ADMINISTRATEUR
  pour acceder au journal "Security".

.EXAMPLE
  .\collect-and-ship.ps1 -Email me@poste.local -MaxPerChannel 100
#>

[CmdletBinding()]
param(
    [string]$ApiUrl = "http://localhost:8000",
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$Password,
    [string[]]$Channels = @(
        "Security",
        "System",
        "Application",
        "Microsoft-Windows-Sysmon/Operational",
        "Microsoft-Windows-PowerShell/Operational"
    ),
    [int]$MaxPerChannel = 100
)

$ErrorActionPreference = "Stop"

if (-not $Password) {
    $secure = Read-Host "Mot de passe DeTecTX pour $Email" -AsSecureString
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

# 1) Authentification -> jeton JWT
Write-Host "[..] Connexion a $ApiUrl" -ForegroundColor Cyan
try {
    $auth = Invoke-RestMethod -Method Post -Uri "$ApiUrl/auth/login" `
        -Body @{ username = $Email; password = $Password } `
        -ContentType "application/x-www-form-urlencoded"
} catch {
    Write-Error "Echec de connexion : $($_.Exception.Message)"
    exit 1
}
$headers = @{ Authorization = "Bearer $($auth.access_token)" }
Write-Host "[OK] Authentifie" -ForegroundColor Green

# 2) Collecte + envoi, canal par canal
$totalSent = 0
foreach ($channel in $Channels) {
    try {
        $winEvents = Get-WinEvent -LogName $channel -MaxEvents $MaxPerChannel -ErrorAction Stop
    } catch {
        Write-Host "[--] $channel : indisponible (ignore)" -ForegroundColor DarkYellow
        continue
    }

    $batch = foreach ($e in $winEvents) {
        # Extraire les champs structurés (EventData) via le XML de l'evenement.
        $fields = @{}
        try {
            $xml = [xml]$e.ToXml()
            foreach ($d in $xml.Event.EventData.Data) {
                if ($d.Name) { $fields[$d.Name] = [string]$d.'#text' }
            }
        } catch {}

        @{
            timestamp = $e.TimeCreated.ToUniversalTime().ToString("o")
            channel   = $e.LogName
            event_id  = [int]$e.Id
            provider  = $e.ProviderName
            computer  = $e.MachineName
            level     = $e.LevelDisplayName
            record_id = [long]$e.RecordId
            message   = $e.Message
            raw       = $fields
        }
    }

    if (-not $batch) { continue }

    $payload = @{ events = @($batch) } | ConvertTo-Json -Depth 6
    $res = Invoke-RestMethod -Method Post -Uri "$ApiUrl/events/ingest" `
        -Headers $headers -Body $payload -ContentType "application/json"

    $totalSent += $res.indexed
    Write-Host "[OK] $channel : $($res.indexed) evenements envoyes" -ForegroundColor Green
}

Write-Host "=== Termine : $totalSent evenements indexes dans DeTecTX ===" -ForegroundColor Cyan
