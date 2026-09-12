<#
  Removes the sandbox from Windows.

    .\install\uninstall.ps1                 remove the app, keep data/ and .env
    .\install\uninstall.ps1 -Purge          remove everything, including data
    .\install\uninstall.ps1 -Dir D:\Sandbox
#>
[CmdletBinding()]
param(
  [string]$Dir,
  [switch]$Purge
)

$ErrorActionPreference = 'Stop'
if (-not $Dir) { $Dir = Join-Path $env:LOCALAPPDATA 'SapBahSandbox' }
$Dir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Dir).TrimEnd('\')

# The same per-install task name sapbah.ps1 uses, so removing one install
# never touches another install's autostart.
$TaskName = 'SapBahSandbox'
if ($Dir -ne (Join-Path $env:LOCALAPPDATA 'SapBahSandbox')) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Dir.ToLowerInvariant()))
  $TaskName = 'SapBahSandbox-' + (-join ($digest[0..3] | ForEach-Object { $_.ToString('x2') }))
}

function Remove-Tree([string]$path) {
  if (-not (Test-Path $path)) { return }
  # Remove-Item -Recurse fails past MAX_PATH, which node_modules trees reach.
  $empty = Join-Path $env:TEMP ('sapbah_empty_' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $empty | Out-Null
  try {
    & robocopy $empty $path /MIR /NFL /NDL /NJH /NJS /NC /NS /NP | Out-Null
    Remove-Item -Recurse -Force $path -ErrorAction SilentlyContinue
  } finally {
    Remove-Item -Recurse -Force $empty -ErrorAction SilentlyContinue
  }
  $global:LASTEXITCODE = 0
}

if (-not (Test-Path $Dir)) { Write-Host "Nothing installed at $Dir"; exit 0 }

# -Purge deletes the whole folder, so make sure it really is a sandbox install.
$markers = @('sapbah.ps1', 'app', 'runtime', '.env') | Where-Object { Test-Path (Join-Path $Dir $_) }
if ($Purge -and -not $markers) {
  Write-Host "$Dir does not look like a SAP BAH Sandbox install - not deleting it." -ForegroundColor Red
  exit 1
}

$ctl = Join-Path $Dir 'sapbah.cmd'
if (Test-Path $ctl) {
  & $ctl service uninstall 2>$null
  & $ctl stop 2>$null
}
# Belt and braces in case the control script was already deleted.
if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
} else {
  cmd /c "schtasks /delete /tn $TaskName /f >nul 2>nul"
}

if ($Purge) {
  Remove-Tree $Dir
  Write-Host "Removed $Dir (including data)."
} else {
  Remove-Tree (Join-Path $Dir 'app')
  Remove-Tree (Join-Path $Dir 'runtime')
  Remove-Tree (Join-Path $Dir 'cache')
  foreach ($item in @('sapbah.ps1', 'sapbah.cmd', 'README.md', 'LICENSE')) {
    $p = Join-Path $Dir $item
    if (Test-Path $p) { Remove-Item -Force $p -ErrorAction SilentlyContinue }
  }
  Write-Host "Removed the app and runtime."
  Write-Host "Kept your database and settings in $Dir"
  Write-Host "  data/  .env       (delete them yourself, or re-run with -Purge)"
}
