<#
    Opens an SSH tunnel to the Contabo VPS and launches Remote Desktop through it.

    RDP on the VPS is bound to 127.0.0.1 only and port 3389 is NOT exposed to the
    internet. Access goes through this SSH tunnel, authenticated by your SSH key.
    Local port 13389 is used to avoid clashing with any local RDP service on 3389.

    Usage:  right-click -> "Run with PowerShell", or:  .\Connect-VpsRdp.ps1
#>

$ErrorActionPreference = "Stop"
$LocalPort = 13389

# Refuse to continue if the local port is already busy.
$busy = Get-NetTCPConnection -LocalPort $LocalPort -State Listen -ErrorAction SilentlyContinue
if ($busy) {
    Write-Host "Port $LocalPort is already in use - a tunnel may already be open." -ForegroundColor Yellow
    Write-Host "Connect Remote Desktop to 127.0.0.1:$LocalPort, or close the existing tunnel first."
    exit 1
}

Write-Host "Opening SSH tunnel to VPS..." -ForegroundColor Cyan
$ssh = Start-Process ssh `
    -ArgumentList "-N", "-o", "ExitOnForwardFailure=yes", "-L", "${LocalPort}:127.0.0.1:3389", "contabo" `
    -PassThru -WindowStyle Hidden

# Wait for the forward to actually come up rather than guessing with a fixed sleep.
$ready = $false
foreach ($i in 1..15) {
    Start-Sleep -Milliseconds 400
    if ($ssh.HasExited) { break }
    $t = Test-NetConnection -ComputerName 127.0.0.1 -Port $LocalPort -WarningAction SilentlyContinue
    if ($t.TcpTestSucceeded) { $ready = $true; break }
}

if (-not $ready) {
    Write-Host "Tunnel failed to come up. Check that 'ssh contabo' works." -ForegroundColor Red
    if (-not $ssh.HasExited) { Stop-Process -Id $ssh.Id -Force }
    exit 1
}

Write-Host "Tunnel up. Launching Remote Desktop -> 127.0.0.1:$LocalPort" -ForegroundColor Green
Write-Host "Log in as user 'ubuntu' with the password you set via 'sudo passwd ubuntu'."

$rdp = Start-Process mstsc -ArgumentList "/v:127.0.0.1:$LocalPort" -PassThru
$rdp.WaitForExit()

Write-Host "Remote Desktop closed. Tearing down tunnel." -ForegroundColor Cyan
if (-not $ssh.HasExited) { Stop-Process -Id $ssh.Id -Force }
