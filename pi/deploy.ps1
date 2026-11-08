<#
  deploy.ps1 - copy Christmas Manager to the Raspberry Pi and run the installer.

  Usage (PowerShell 5.1, from anywhere):
    powershell -ExecutionPolicy Bypass -File pi\deploy.ps1
    powershell -ExecutionPolicy Bypass -File pi\deploy.ps1 -PiHost 192.168.1.50 -User elija

  Uses the OpenSSH client built into Windows 10/11 (ssh, scp, tar).
  No passwords are stored or passed: ssh asks you for them itself.
#>
param(
  [string]$PiHost = 'raspberrypi.local',
  [string]$User = 'pi'
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
  Write-Host ''
  Write-Host "ERROR: $msg" -ForegroundColor Red
  exit 1
}

# Project root = parent of the pi\ folder this script lives in.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

foreach ($tool in 'ssh', 'scp', 'tar') {
  if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
    Fail "'$tool' not found. Install it: Settings > Apps > Optional features > OpenSSH Client (tar ships with Windows 10 1803+)."
  }
}

# 1. Can we reach the Pi's SSH port (22)? ---------------------------------
Write-Host "Checking $PiHost ..."
$reachable = $false
try {
  $client = New-Object System.Net.Sockets.TcpClient
  $iar = $client.BeginConnect($PiHost, 22, $null, $null)
  if ($iar.AsyncWaitHandle.WaitOne(6000, $false) -and $client.Connected) {
    $client.EndConnect($iar)
    $reachable = $true
  }
  $client.Close()
} catch {
  $reachable = $false
}
if (-not $reachable) {
  Write-Host "Could not reach $PiHost on SSH port 22." -ForegroundColor Yellow
  Write-Host '  1. Is the Pi powered on and on the same Wi-Fi/network as this PC? (give it a minute after boot)'
  Write-Host "  2. Try:  ping $PiHost"
  Write-Host '     If that fails, check the hostname, or use the Pi''s IP: -PiHost 192.168.x.x (see your router''s device list).'
  Write-Host '  3. SSH must be enabled: in Raspberry Pi Imager use the gear / "Edit settings" > Services > Enable SSH,'
  Write-Host '     and set the same username you pass with -User. Re-flash the card if you skipped it.'
  Write-Host '  4. If you use Tailscale on the Pi, you can pass its 100.x address or MagicDNS name instead.'
  Fail "Pi not reachable at $PiHost."
}

# 2. Pack the project (no .git, node_modules, data) ------------------------
$tmp = Join-Path $env:TEMP 'christmas-manager-deploy.tar'
if (Test-Path $tmp) { Remove-Item $tmp -Force }
Write-Host "Packing $root ..."
& tar -cf $tmp --exclude '.git' --exclude 'node_modules' --exclude './data' -C $root .
if ($LASTEXITCODE -ne 0) { Fail 'tar failed to pack the project.' }

# 3. Copy and unpack on the Pi --------------------------------------------
$target = "$User@$PiHost"
Write-Host "Copying to $target (enter the Pi password if asked) ..."
& scp -o ConnectTimeout=10 $tmp "${target}:/tmp/christmas-manager-deploy.tar"
if ($LASTEXITCODE -ne 0) {
  Fail "scp failed. Wrong username (-User $User)? Wrong password? Is SSH enabled on the Pi?"
}
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

# 4. Unpack, strip CRLF from shell scripts, and run the installer ----------
$remote = 'mkdir -p ~/christmas-manager && tar -xf /tmp/christmas-manager-deploy.tar -C ~/christmas-manager && rm -f /tmp/christmas-manager-deploy.tar && find ~/christmas-manager/pi -name "*.sh" -exec sed -i "s/\r$//" {} + && sudo sh ~/christmas-manager/pi/setup.sh'
Write-Host 'Running the installer on the Pi (sudo may ask for the password again) ...'
& ssh -t -o ConnectTimeout=10 $target $remote
if ($LASTEXITCODE -ne 0) {
  Fail "Installer exited with code $LASTEXITCODE. Scroll up for the reason; fix it and run deploy.ps1 again (it is safe to repeat)."
}

Write-Host ''
Write-Host 'Deploy finished. Open the URLs printed above.' -ForegroundColor Green
