<#
  Stand-alone installer for Windows.

  Downloads a private Node runtime, builds the app against it, installs
  everything into one self-contained directory, and (optionally) registers
  autostart. The system Node, if there even is one, is never touched.

  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a .ps1 without
  a BOM as Windows-1252, so a UTF-8 em dash decodes into bytes that include a
  curly quote, which PowerShell accepts as a string delimiter and which
  silently desynchronises the parser.

    .\install\install.ps1                        install + register autostart
    .\install\install.ps1 -Dir D:\Sandbox        choose the location
    .\install\install.ps1 -NoService             skip autostart registration
    .\install\install.ps1 -Offline               use a runtime already in .cache

  If Windows blocks the script, run:
    powershell -ExecutionPolicy Bypass -File .\install\install.ps1
#>
[CmdletBinding()]
param(
  [string]$Dir,
  [switch]$NoService,
  [switch]$Offline
)

$ErrorActionPreference = 'Stop'
$ProgressPreference    = 'SilentlyContinue'

$NodeVersion = 'v24.18.0'          # Node 24 LTS "Krypton"
$SrcDir      = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
# "sapbah update" points SAPBAH_CACHE into the install folder, so the runtime
# download survives from one update to the next.
$Cache       = if ($env:SAPBAH_CACHE) { $env:SAPBAH_CACHE } else { Join-Path $SrcDir '.cache' }

function Say  ($m) { Write-Host $m -ForegroundColor White }
function Note ($m) { Write-Host "  $m" -ForegroundColor DarkGray }
function Die  ($m) { Write-Host $m -ForegroundColor Red; exit 1 }

function Remove-Tree([string]$path) {
  if (-not (Test-Path $path)) { return }
  # Remove-Item -Recurse fails on paths longer than MAX_PATH, which nested
  # node_modules trees reach easily. Mirroring an empty directory over the
  # target with robocopy has no such limit; the rmdir then always succeeds.
  $empty = Join-Path $env:TEMP ('sapbah_empty_' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $empty | Out-Null
  try {
    & robocopy $empty $path /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue
  } finally {
    Remove-Item -Recurse -Force $empty -ErrorAction SilentlyContinue
  }
  # robocopy sets a non-zero exit code for informational results; ignore it.
  $global:LASTEXITCODE = 0
}

# --- Platform --------------------------------------------------------------

$arch = $env:PROCESSOR_ARCHITECTURE
switch ($arch) {
  'AMD64' { $NodeArch = 'x64' }
  'ARM64' { $NodeArch = 'arm64' }
  default { Die "Unsupported CPU architecture: $arch" }
}

if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'SapBahSandbox' }
# Later steps change directory, so a relative -Dir must be pinned down now.
$Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir)
$NodePkg     = "node-$NodeVersion-win-$NodeArch"
$NodeArchive = "$NodePkg.zip"

Say 'SAP BAH Sandbox - stand-alone install'
Note "platform : win-$NodeArch"
Note "runtime  : Node $NodeVersion (bundled, not installed system-wide)"
Note "target   : $Dir"
Write-Host ''

# --- Download and verify the runtime ---------------------------------------

New-Item -ItemType Directory -Force $Cache | Out-Null
$archivePath = Join-Path $Cache $NodeArchive

if (-not (Test-Path $archivePath)) {
  if ($Offline) { Die "Offline mode, but $archivePath is missing." }
  Say 'Downloading the Node runtime (~37 MB)...'
  try {
    Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/$NodeArchive" -OutFile $archivePath -UseBasicParsing
  } catch { Die "Download failed: $($_.Exception.Message)" }
}

if (-not $Offline) {
  Say 'Verifying checksum...'
  $sums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" -UseBasicParsing).Content
  $line = ($sums -split "`n" | Where-Object { $_ -match [regex]::Escape($NodeArchive) + '\s*$' } | Select-Object -First 1)
  if (-not $line) { Die "No checksum published for $NodeArchive." }
  $expected = ($line -split '\s+')[0]
  $actual   = (Get-FileHash -Path $archivePath -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected.ToLower()) {
    Die "Checksum mismatch - refusing to install. Delete $archivePath and retry."
  }
  Note "ok  $($expected.Substring(0,16))..."
}

# --- Lay out the install directory -----------------------------------------

Say "Installing to $Dir..."
New-Item -ItemType Directory -Force (Join-Path $Dir 'data') | Out-Null

# An upgrade must not fight the running instance. Windows refuses to delete an
# executable that a process is running, which would leave the runtime folder
# present-but-gutted and make the fresh copy land inside it as a subfolder.
$existingCtl = Join-Path $Dir 'sapbah.cmd'
if (Test-Path $existingCtl) {
  Say 'Stopping the running instance...'
  & $existingCtl stop 2>&1 | Out-Null
}
Get-Process node -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($Dir, [System.StringComparison]::OrdinalIgnoreCase) } |
  ForEach-Object {
    Note "stopping stray node process (pid $($_.Id))"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
Start-Sleep -Milliseconds 750

# Replace the runtime wholesale so a re-install upgrades it cleanly.
$runtime = Join-Path $Dir 'runtime'
Remove-Tree $runtime
# Refuse to continue rather than nesting the new runtime inside the old one.
if (Test-Path $runtime) {
  Die @"
Could not replace $runtime - something is still using it.
Close anything running from that folder, then try again. To force it:
  taskkill /f /im node.exe
"@
}
$staging = Join-Path $Cache 'unpack'
Remove-Tree $staging
New-Item -ItemType Directory -Force $staging | Out-Null

# tar.exe ships with Windows 10+ and unpacks zip faster than Expand-Archive.
& tar.exe -xf $archivePath -C $staging
if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $archivePath -DestinationPath $staging -Force }
Move-Item (Join-Path $staging $NodePkg) $runtime
Remove-Tree $staging

$Node = Join-Path $runtime 'node.exe'
$Npm  = Join-Path $runtime 'npm.cmd'
if (-not (Test-Path $Node)) { Die "Extraction failed - $Node not found." }
# node.exe alone is not proof of a good extraction: a half-replaced runtime can
# keep the old locked node.exe while everything around it is missing.
if (-not (Test-Path $Npm)) {
  Die @"
Runtime extraction is incomplete - $Npm is missing.
Delete this folder and run the installer again:
  $runtime
"@
}
Note "bundled Node: $(& $Node -v)"

# --- Build the app with the bundled runtime --------------------------------

Say 'Building...'
$env:Path = "$runtime;$env:Path"
Push-Location $SrcDir
try {
  # ci, not install: the exact dependency versions in package-lock.json.
  & $Npm ci --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { Die 'npm ci failed.' }
  & $Npm run build --silent
  if ($LASTEXITCODE -ne 0) { Die 'Build failed.' }
} finally { Pop-Location }

Say 'Assembling...'
$app = Join-Path $Dir 'app'
Remove-Tree $app
New-Item -ItemType Directory -Force $app | Out-Null
Copy-Item -Recurse (Join-Path $SrcDir 'dist')   (Join-Path $app 'dist')
Copy-Item -Recurse (Join-Path $SrcDir 'public') (Join-Path $app 'public')
Copy-Item (Join-Path $SrcDir 'package.json')    (Join-Path $app 'package.json')
Copy-Item (Join-Path $SrcDir 'package-lock.json') (Join-Path $app 'package-lock.json')

# A fresh production-only install, so the bundle carries no build tooling.
Push-Location $app
try {
  & $Npm ci --omit=dev --no-audit --no-fund --silent
  if ($LASTEXITCODE -ne 0) { Die 'Production dependency install failed.' }
} finally { Pop-Location }

# --- Configuration ---------------------------------------------------------

$envFile = Join-Path $Dir '.env'
if (-not (Test-Path $envFile)) {
  Copy-Item (Join-Path $SrcDir '.env.example') $envFile
  $bytes = New-Object byte[] 24
  [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $key = ([Convert]::ToBase64String($bytes) -replace '[/+=]', '').Substring(0, 24)
  (Get-Content $envFile) -replace '^ADMIN_KEY=.*', "ADMIN_KEY=$key" |
    Set-Content $envFile -Encoding utf8
  Note "wrote .env with a generated ADMIN_KEY: $key"
} else {
  Note 'kept the existing .env'
}

Copy-Item (Join-Path $SrcDir 'install\templates\sapbah.ps1') (Join-Path $Dir 'sapbah.ps1') -Force
Copy-Item (Join-Path $SrcDir 'install\templates\sapbah.cmd') (Join-Path $Dir 'sapbah.cmd') -Force
Copy-Item (Join-Path $SrcDir 'README.md') (Join-Path $Dir 'README.md') -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $SrcDir 'LICENSE') (Join-Path $Dir 'LICENSE') -Force -ErrorAction SilentlyContinue

# --- Autostart -------------------------------------------------------------

$ctl = Join-Path $Dir 'sapbah.cmd'
if (-not $NoService) {
  Say 'Registering autostart...'
  & $ctl service install
}
& $ctl start

$port = '8080'
$m = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -Last 1
if ($m) { $port = $m.Matches[0].Groups[1].Value }
$ip = (Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
        Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
        Select-Object -First 1).IPAddress

Write-Host ''
Say 'Done.'
Write-Host ''
Note "UI            http://127.0.0.1:$port/"
Note "From the LAN  http://$(if ($ip) { $ip } else { '<this-host>' }):$port/"
Note "Control       $ctl  start | stop | status | logs | open"
Note "Config        $envFile"
Note "Data          $(Join-Path $Dir 'data')"
Write-Host ''
Note 'If Windows Firewall prompts, allow it on private networks so the LAN can reach the mocks.'
Note "To open the port manually:  netsh advfirewall firewall add rule name=`"SAP BAH Sandbox`" dir=in action=allow protocol=TCP localport=$port"
