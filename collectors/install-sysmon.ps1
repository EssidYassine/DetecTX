<#
  install-sysmon.ps1 - Installe (ou met a jour) Sysmon avec la config DeTecTX.

  A lancer dans un PowerShell ADMINISTRATEUR :
      powershell -ExecutionPolicy Bypass -File .\collectors\install-sysmon.ps1

  - Utilise le binaire local collectors\tools\Sysmon64.exe (sinon PATH, sinon telechargement).
  - Installe le driver + applique collectors\config\sysmon-config.xml.
  - Idempotent : si Sysmon est deja la, il RECHARGE juste la config (-c).
  - Script volontairement ASCII pur (Windows PowerShell 5.1 lit les .ps1 en ANSI).
#>

[CmdletBinding()]
param(
    [string]$ConfigPath = (Join-Path $PSScriptRoot "config\sysmon-config.xml")
)

$ErrorActionPreference = "Stop"

function Assert-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p = New-Object Security.Principal.WindowsPrincipal($id)
    if (-not $p.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        Write-Host "[X] Ce script exige des droits ADMINISTRATEUR." -ForegroundColor Red
        Write-Host "    Ouvre 'Windows Terminal (Admin)' puis relance-le." -ForegroundColor Yellow
        exit 1
    }
}

Assert-Admin

# Journalise tout pour un diagnostic fiable meme si la fenetre se ferme.
$logFile = Join-Path $PSScriptRoot "tools\install-log.txt"
try { Start-Transcript -Path $logFile -Force | Out-Null } catch {}

if (-not (Test-Path $ConfigPath)) {
    Write-Host "[X] Config introuvable : $ConfigPath" -ForegroundColor Red
    exit 1
}
Write-Host "[*] Config : $ConfigPath" -ForegroundColor Cyan

# --- Recupere sysmon64.exe : binaire local du projet > PATH > telechargement ---
$localSysmon = Join-Path $PSScriptRoot "tools\Sysmon64.exe"
$sysmon = if (Test-Path $localSysmon) { $localSysmon } else {
    (Get-Command sysmon64.exe, sysmon.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
}
if (-not $sysmon) {
    $work = Join-Path $env:TEMP "detectx-sysmon"
    New-Item -ItemType Directory -Force -Path $work | Out-Null
    $zip = Join-Path $work "Sysmon.zip"
    Write-Host "[*] Telechargement de Sysmon (Sysinternals)..." -ForegroundColor Cyan
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri "https://download.sysinternals.com/files/Sysmon.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive -Path $zip -DestinationPath $work -Force
    $sysmon = Join-Path $work "Sysmon64.exe"
    if (-not (Test-Path $sysmon)) { $sysmon = Join-Path $work "Sysmon.exe" }
}
Write-Host "[*] Binaire Sysmon : $sysmon" -ForegroundColor Cyan

# --- Installe ou met a jour ---
$installed = Get-Service -Name "Sysmon64","Sysmon" -ErrorAction SilentlyContinue
if ($installed) {
    Write-Host "[*] Sysmon deja installe -> rechargement de la config..." -ForegroundColor Yellow
    & $sysmon -c $ConfigPath
} else {
    Write-Host "[*] Installation de Sysmon + config..." -ForegroundColor Yellow
    & $sysmon -accepteula -i $ConfigPath
}

Start-Sleep -Seconds 2
$log = Get-WinEvent -ListLog "Microsoft-Windows-Sysmon/Operational" -ErrorAction SilentlyContinue
if ($log) {
    Write-Host "[OK] Sysmon actif. Canal 'Microsoft-Windows-Sysmon/Operational' present (RecordCount=$($log.RecordCount))." -ForegroundColor Green
    Write-Host "[OK] Ton agent DeTecTX va maintenant ingerer ces evenements automatiquement." -ForegroundColor Green
} else {
    Write-Host "[!] Le canal Sysmon n'est pas encore visible - attends quelques secondes puis verifie l'Observateur d'evenements." -ForegroundColor Yellow
}

try { Stop-Transcript | Out-Null } catch {}
Write-Host ""
Write-Host "==> Tu peux fermer cette fenetre. (journal: $logFile)" -ForegroundColor Cyan
