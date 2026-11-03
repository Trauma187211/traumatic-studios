param(
  [string]$Target = (Join-Path ([Environment]::GetFolderPath("Desktop")) "Traumatic Studios Hosted"),
  [string]$NodeExe = (Join-Path ([Environment]::GetFolderPath("Desktop")) "Traumatic Studios\runtime\node.exe")
)
# Builds a separate, self-contained copy of the studio for sharing online.
# It contains code and a node runtime only: no owner settings, no API keys, no saved projects, no learned data.
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
New-Item $Target -ItemType Directory -Force | Out-Null
Get-ChildItem $src -Filter *.js | Where-Object { $_.Name -notmatch '\.test\.js$' -and $_.Name -notmatch '^files-' -and $_.Name -notmatch 'research-daemon|blueprint-harness' } | Copy-Item -Destination $Target -Force
Copy-Item (Join-Path $src "package.json"), (Join-Path $src "seed-knowledge.json") $Target -Force
Copy-Item (Join-Path $src "public") $Target -Recurse -Force
if (Test-Path $NodeExe) { New-Item (Join-Path $Target "runtime") -ItemType Directory -Force | Out-Null; Copy-Item $NodeExe (Join-Path $Target "runtime\node.exe") -Force }
New-Item (Join-Path $Target "data"), (Join-Path $Target "projects") -ItemType Directory -Force | Out-Null

$passFile = Join-Path $Target "data\access-password.txt"
if (-not (Test-Path $passFile)) { [IO.File]::WriteAllText($passFile, "CHANGE-ME-before-sharing`r`n") }

$bat = @'
@echo off
rem Starts the HOSTED studio on port 3100 and opens a public Cloudflare quick tunnel to it.
rem Everyone must sign in with the password in data\access-password.txt. Owner settings and keys are disabled.
setlocal
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
set STUDIO_HOSTED=1
set PORT=3100
set OPENAI_API_KEY=
set OPENAI_BASE_URL=
set OPENAI_MODEL=
start "Traumatic Studios (hosted server)" /min "%NODE%" server.js
timeout /t 3 >nul
set "CF=cloudflared"
if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
echo Look for the https://....trycloudflare.com link below and send it to friends with the password.
"%CF%" tunnel --url http://localhost:3100
'@
[IO.File]::WriteAllText((Join-Path $Target "START HOSTED.bat"), $bat.Replace("`n", "`r`n"))

$notes = @'
Traumatic Studios - HOSTED copy

1. Put a password (8+ characters) in data\access-password.txt.
2. Double-click "START HOSTED.bat". Share the trycloudflare.com link and the password.
3. Close both windows to stop sharing.

This copy has no owner: every visitor signs in, gets their own temporary AI connection (free local/Pollinations models, or their own API key), and cannot change the host's settings, keys, research or knowledge.
Your own app (port 3000) is a different folder and is not reachable through this link.
'@
[IO.File]::WriteAllText((Join-Path $Target "READ ME.txt"), $notes.Replace("`n", "`r`n"))
Write-Output "Hosted build ready: $Target"
