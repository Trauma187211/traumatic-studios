# Builds the public download: dist\Traumatic-Studios-Windows.zip
# Clean by construction: code + Node runtime + empty data/projects. No settings, keys, passwords, saved projects or learned data.
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot
$NodeExe = (Join-Path ([Environment]::GetFolderPath("Desktop")) "Traumatic Studios\runtime\node.exe")
$out = Join-Path $src "dist"
$stage = Join-Path $out "Traumatic Studios"
Remove-Item $out -Recurse -Force -ErrorAction SilentlyContinue
New-Item $stage -ItemType Directory -Force | Out-Null

Get-ChildItem $src -Filter *.js | Where-Object { $_.Name -notmatch '\.test\.js$' -and $_.Name -notmatch '^files-' -and $_.Name -ne 'blueprint-harness.js' } | Copy-Item -Destination $stage -Force
Copy-Item (Join-Path $src "package.json"), (Join-Path $src "seed-knowledge.json"), (Join-Path $src "LICENSE") $stage -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $src "public") $stage -Recurse -Force
New-Item (Join-Path $stage "runtime") -ItemType Directory | Out-Null
Copy-Item $NodeExe (Join-Path $stage "runtime\node.exe") -Force
New-Item (Join-Path $stage "data"), (Join-Path $stage "projects") -ItemType Directory | Out-Null

$start = @'
@echo off
rem Starts Traumatic Studios on this PC and opens it in your browser. Close this window to stop it.
setlocal
cd /d "%~dp0"
set "NODE=%~dp0runtime\node.exe"
if not exist "%NODE%" set "NODE=node"
set PORT=3000
start "" "http://localhost:3000"
"%NODE%" server.js
pause
'@
$setup = @'
@echo off
rem One-time helper: installs Ollama (free local AI) and downloads the coding model (about 5 GB).
echo This installs Ollama and the free qwen2.5-coder:7b model so the studio can build games on YOUR computer.
echo Everything runs locally; nothing is sent anywhere. Press Ctrl+C to cancel.
pause
where ollama >nul 2>nul
if errorlevel 1 (
  winget install -e --id Ollama.Ollama --accept-source-agreements --accept-package-agreements
)
set "OL=ollama"
if exist "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" set "OL=%LOCALAPPDATA%\Programs\Ollama\ollama.exe"
"%OL%" pull qwen2.5-coder:7b
echo.
echo Done. Now run START.bat.
pause
'@
$readme = @'
TRAUMATIC STUDIOS  -  your own AI game studio, running on your PC

1. Unzip this folder anywhere (do not run it from inside the zip).
2. (Recommended, once) Double-click "SETUP AI.bat". It installs Ollama and a free coding model so builds run locally. Skip it to use the free online fallback (slow) or add your own API key in the app.
3. Double-click "START.bat". Your browser opens the studio. Describe a game and the team builds it.
4. Every game has a Download button that gives you a .zip with index.html you can play and publish.

Privacy: everything stays on your computer. No account, no tracking. Any API key you enter is only used by your copy.
Windows may show "Windows protected your PC" because the app is unsigned: click "More info", then "Run anyway".
Needs Windows 10/11, about 6 GB free disk space for the local model, 8 GB+ RAM (16 GB better).
Licence: MIT.
'@
foreach ($pair in @(@("START.bat", $start), @("SETUP AI.bat", $setup), @("READ ME FIRST.txt", $readme))) { [IO.File]::WriteAllText((Join-Path $stage $pair[0]), $pair[1].Replace("`r`n", "`n").Replace("`n", "`r`n")) }

# Safety scan: refuse to package anything that looks like a secret or personal data.
$bad = Get-ChildItem $stage -Recurse -File | Where-Object { $_.Name -match 'settings\.json|access-password|\.env' }
$secretWords = @()
foreach ($file in @((Join-Path ([Environment]::GetFolderPath("Desktop")) "Traumatic Studios\data\access-password.txt"), (Join-Path ([Environment]::GetFolderPath("Desktop")) "Traumatic Studios Hosted\data\access-password.txt"))) {
  if (Test-Path $file) { $secretWords += (Get-Content $file -Raw).Trim() }
}
$secretWords += $env:USERPROFILE
$pattern = (@('sk-[A-Za-z0-9]{20,}', 'AIza[0-9A-Za-z_-]{30,}', 'gsk_[A-Za-z0-9]{20,}') + @($secretWords | Where-Object { $_ } | ForEach-Object { [regex]::Escape($_) })) -join '|'
$hits = Get-ChildItem $stage -Recurse -File -Include *.js,*.json,*.txt,*.bat,*.html | Where-Object { $_.Length -lt 3MB } | Select-String -Pattern $pattern -List
if ($bad -or $hits) { throw "Release blocked, found: $(@($bad.Name) + @($hits.Path) -join ', ')" }
if (Get-ChildItem (Join-Path $stage "data"), (Join-Path $stage "projects") -Force) { throw "data/projects must be empty" }

$zip = Join-Path $out "Traumatic-Studios-Windows.zip"
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal
"{0}  ({1:N0} MB)" -f $zip, ((Get-Item $zip).Length / 1MB)
