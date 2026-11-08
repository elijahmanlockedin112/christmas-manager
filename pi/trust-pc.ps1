# One-time: lets this PC log in to the Pi with a key (you type the Pi password once).
# Run from PowerShell:  .\pi\trust-pc.ps1
param([string]$PiHost = "raspberrypi.local")
$ErrorActionPreference = "Stop"
$key = Join-Path $env:USERPROFILE ".ssh\id_ed25519_northpole.pub"
if (-not (Test-Path $key)) { & ssh-keygen -q -t ed25519 -N '""' -C "north-pole-control" -f ($key -replace '\.pub$', '') }
Write-Host ""
Write-Host "North Pole Control: connect this PC to the Raspberry Pi at $PiHost" -ForegroundColor Green
$user = Read-Host "Pi username (the one you log in with, often pi)"
if (-not $user) { $user = "pi" }
Write-Host "Now type the Pi's password when asked (it won't show as you type)." -ForegroundColor Yellow
Get-Content $key | & ssh -o StrictHostKeyChecking=accept-new "$user@$PiHost" "mkdir -p ~/.ssh && chmod 700 ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && echo KEY-INSTALLED"
$cfg = Join-Path $env:USERPROFILE ".ssh\config"
$block = "`nHost northpole $PiHost raspberrypi.local`n  HostName $PiHost`n  User $user`n  IdentityFile ~/.ssh/id_ed25519_northpole`n"
if (-not (Test-Path $cfg) -or -not (Select-String -Path $cfg -Pattern "Host northpole" -Quiet)) { Add-Content -Path $cfg -Value $block -Encoding ascii }
& ssh -o BatchMode=yes northpole "echo; echo 'Connected to:' `$(cat /proc/device-tree/model)"
Write-Host "Done. Tell Claude 'pi is connected'." -ForegroundColor Green
