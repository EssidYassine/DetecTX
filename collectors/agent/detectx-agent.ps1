<#
.SYNOPSIS
  Agent DeTecTX - surveillance continue de l'hote et centralisation des logs.

.DESCRIPTION
  Toutes les IntervalSec secondes, envoie a DeTecTX (/events/ingest) :
   1. Activite fichiers/dossiers (creation / modification / suppression) dans WatchPaths
   2. Nouveaux evenements Windows (System, Security, Application, PowerShell, Sysmon) - incrementaux
   3. Nouvelles lignes des fichiers .log presents dans LogFolders (centralisation)

  Lancer PowerShell EN ADMINISTRATEUR pour couvrir le journal Security (boot, logons).
  Arreter avec Ctrl+C.

.EXAMPLE
  .\detectx-agent.ps1 -Email me@poste.local -IntervalSec 15
.EXAMPLE
  .\detectx-agent.ps1 -Email me@poste.local -LogFolders "C:\Logs","D:\app\logs"
#>

[CmdletBinding()]
param(
    [string]$ApiUrl = "http://localhost:8000",
    [Parameter(Mandatory = $true)][string]$Email,
    [string]$Password,
    [int]$IntervalSec = 15,
    [string[]]$WatchPaths,
    [string[]]$LogFolders = @(),
    [int]$MaxDepth = 2,
    [int]$MaxPerChannel = 40
)

$ErrorActionPreference = "Stop"

if (-not $WatchPaths) {
    $WatchPaths = @(
        "$env:USERPROFILE\Desktop",
        "$env:USERPROFILE\Documents",
        "$env:USERPROFILE\Downloads",
        "$env:APPDATA\Microsoft\Windows\Start Menu\Programs\Startup",
        "$env:TEMP"
    )
}
$WinChannels = @(
    "System", "Security", "Application",
    "Microsoft-Windows-PowerShell/Operational",
    "Microsoft-Windows-Sysmon/Operational"
)

if (-not $Password) {
    $secure = Read-Host "Mot de passe DeTecTX pour $Email" -AsSecureString
    $Password = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}

$auth = Invoke-RestMethod -Method Post -Uri "$ApiUrl/auth/login" `
    -Body @{ username = $Email; password = $Password } `
    -ContentType "application/x-www-form-urlencoded"
$headers = @{ Authorization = "Bearer $($auth.access_token)" }
Write-Host "[OK] Agent DeTecTX connecte. Surveillance continue (Ctrl+C pour arreter)." -ForegroundColor Green
Write-Host ("     Dossiers surveilles: " + ($WatchPaths -join " ; ")) -ForegroundColor DarkGray

function Send-Events($evts) {
    if (-not $evts -or @($evts).Count -eq 0) { return 0 }
    $payload = @{ events = @($evts) } | ConvertTo-Json -Depth 6
    try {
        $r = Invoke-RestMethod -Method Post -Uri "$ApiUrl/events/ingest" `
            -Headers $headers -Body $payload -ContentType "application/json"
        return $r.indexed
    } catch {
        Write-Host "[--] Envoi echoue: $($_.Exception.Message)" -ForegroundColor DarkYellow
        return 0
    }
}

function New-FileEvent($eid, $level, $change, $path) {
    @{
        timestamp = (Get-Date).ToUniversalTime().ToString("o")
        channel   = "DeTecTX-FileMonitor"
        event_id  = $eid
        provider  = "DeTecTX-Agent"
        computer  = $env:COMPUTERNAME
        level     = $level
        record_id = $null
        message   = "$change $path"
        raw       = @{ Path = $path; ChangeType = $change; Directory = (Split-Path $path -ErrorAction SilentlyContinue) }
    }
}

function Scan-Files {
    $map = @{}
    foreach ($p in $WatchPaths) {
        if (-not (Test-Path $p)) { continue }
        try {
            Get-ChildItem -LiteralPath $p -Recurse -Depth $MaxDepth -File -Force -ErrorAction SilentlyContinue |
                ForEach-Object { $map[$_.FullName] = ("{0}:{1}" -f $_.LastWriteTimeUtc.Ticks, $_.Length) }
        } catch {}
    }
    return $map
}

# Etat initial (on ne signale que les changements APRES le demarrage)
$prev = Scan-Files
$winBook = @{}
foreach ($ch in $WinChannels) {
    try { $winBook[$ch] = (Get-WinEvent -LogName $ch -MaxEvents 1 -ErrorAction Stop).RecordId }
    catch { $winBook[$ch] = $null }
}
$logPos = @{}
foreach ($lf in $LogFolders) {
    if (Test-Path $lf) {
        Get-ChildItem $lf -Filter *.log -File -ErrorAction SilentlyContinue |
            ForEach-Object { $logPos[$_.FullName] = $_.Length }
    }
}

while ($true) {
    Start-Sleep -Seconds $IntervalSec
    $batch = New-Object System.Collections.ArrayList

    # 1) Activite fichiers (diff de snapshot)
    $cur = Scan-Files
    foreach ($k in $cur.Keys) {
        if (-not $prev.ContainsKey($k)) {
            [void]$batch.Add((New-FileEvent 1 "Information" "CREATED" $k))
        } elseif ($prev[$k] -ne $cur[$k]) {
            [void]$batch.Add((New-FileEvent 2 "Information" "MODIFIED" $k))
        }
    }
    foreach ($k in $prev.Keys) {
        if (-not $cur.ContainsKey($k)) {
            [void]$batch.Add((New-FileEvent 3 "Warning" "DELETED" $k))
        }
    }
    $prev = $cur

    # 2) Nouveaux evenements Windows (incrementaux via RecordId)
    foreach ($ch in $WinChannels) {
        try { $evs = Get-WinEvent -LogName $ch -MaxEvents $MaxPerChannel -ErrorAction Stop }
        catch { continue }
        if (-not $evs) { continue }
        $bk = $winBook[$ch]
        $new = if ($bk) { $evs | Where-Object { $_.RecordId -gt $bk } } else { @() }
        foreach ($e in ($new | Sort-Object RecordId)) {
            $fields = @{}
            try {
                $xml = [xml]$e.ToXml()
                foreach ($d in $xml.Event.EventData.Data) { if ($d.Name) { $fields[$d.Name] = [string]$d.'#text' } }
            } catch {}
            [void]$batch.Add(@{
                timestamp = $e.TimeCreated.ToUniversalTime().ToString("o")
                channel   = $e.LogName
                event_id  = [int]$e.Id
                provider  = $e.ProviderName
                computer  = $e.MachineName
                level     = $e.LevelDisplayName
                record_id = [long]$e.RecordId
                message   = $e.Message
                raw       = $fields
            })
        }
        $winBook[$ch] = ($evs | Measure-Object -Property RecordId -Maximum).Maximum
    }

    # 3) Centralisation des fichiers .log (tail des nouvelles lignes)
    foreach ($lf in $LogFolders) {
        if (-not (Test-Path $lf)) { continue }
        Get-ChildItem $lf -Filter *.log -File -ErrorAction SilentlyContinue | ForEach-Object {
            $f = $_.FullName; $len = $_.Length
            $old = if ($logPos.ContainsKey($f)) { $logPos[$f] } else { 0 }
            if ($len -gt $old) {
                try {
                    $fs = [IO.File]::Open($f, 'Open', 'Read', 'ReadWrite')
                    [void]$fs.Seek($old, 'Begin')
                    $sr = New-Object IO.StreamReader($fs)
                    $chunk = $sr.ReadToEnd(); $sr.Close(); $fs.Close()
                    foreach ($line in ($chunk -split "`n")) {
                        $t = $line.Trim()
                        if ($t) {
                            [void]$batch.Add(@{
                                timestamp = (Get-Date).ToUniversalTime().ToString("o")
                                channel = "DeTecTX-LogFile"; event_id = 0; provider = "DeTecTX-Agent"
                                computer = $env:COMPUTERNAME; level = "Information"; record_id = $null
                                message = $t; raw = @{ File = $f }
                            })
                        }
                    }
                } catch {}
            }
            $logPos[$f] = $len
        }
    }

    $n = Send-Events $batch
    Write-Host ("[{0}] {1} evenements centralises" -f (Get-Date -Format HH:mm:ss), $n) -ForegroundColor Cyan
}
