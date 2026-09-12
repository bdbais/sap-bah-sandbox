<#
  SAP BAH Sandbox control script (Windows).

    sapbah start | stop | restart | status | logs | open
    sapbah sync [--filter X] [--specs]
    sapbah test --mock <slug> [--read-only]
    sapbah update [--check] [--force]
    sapbah service install | uninstall

  Uses the Node runtime bundled next to it; the system Node is never touched.

  NOTE: keep this file pure ASCII. Windows PowerShell 5.1 reads a .ps1 without
  a BOM as Windows-1252, and a UTF-8 character such as an em dash decodes into
  bytes that include a curly quote, which PowerShell accepts as a string
  delimiter. That silently desynchronises the parser and merges function bodies.
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Command = 'help',
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)][string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$Here     = Split-Path -Parent $MyInvocation.MyCommand.Path
$Node     = Join-Path $Here 'runtime\node.exe'
$App      = Join-Path $Here 'app'
$Data     = Join-Path $Here 'data'
$PidFile  = Join-Path $Data 'sandbox.pid'
$LogOut   = Join-Path $Data 'sandbox.log'
$LogErr   = Join-Path $Data 'sandbox.err.log'
# One scheduled task per install: a second copy elsewhere (a test install, say)
# must not take over, or remove, the autostart of the first. The default
# location keeps the plain name. uninstall.ps1 derives the same name.
$TaskName = 'SapBahSandbox'
if ($Here.TrimEnd('\') -ne (Join-Path $env:LOCALAPPDATA 'SapBahSandbox')) {
  $sha = [System.Security.Cryptography.SHA256]::Create()
  $digest = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($Here.TrimEnd('\').ToLowerInvariant()))
  $TaskName = 'SapBahSandbox-' + (-join ($digest[0..3] | ForEach-Object { $_.ToString('x2') }))
}

if (-not (Test-Path $Node)) { Write-Error "Bundled Node runtime is missing: $Node" }
if (-not (Test-Path $Data)) { New-Item -ItemType Directory -Force $Data | Out-Null }

function Get-Port {
  $envFile = Join-Path $Here '.env'
  if (Test-Path $envFile) {
    $line = Select-String -Path $envFile -Pattern '^PORT=(\d+)' | Select-Object -Last 1
    if ($line) { return $line.Matches[0].Groups[1].Value }
  }
  return '8080'
}

function Get-Url { "http://127.0.0.1:$(Get-Port)" }

function Get-RunningProcess {
  if (-not (Test-Path $PidFile)) { return $null }
  $id = (Get-Content $PidFile -ErrorAction SilentlyContinue | Select-Object -First 1)
  if (-not $id) { return $null }
  $p = Get-Process -Id ([int]$id) -ErrorAction SilentlyContinue
  # Guard against the PID having been recycled by an unrelated process.
  if ($p -and $p.ProcessName -eq 'node') { return $p }
  return $null
}

function Test-TaskRegistered {
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    return [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
  }
  # Route through cmd so schtasks' "not found" message never reaches PowerShell
  # as an ErrorRecord (which would throw under ErrorActionPreference = Stop).
  cmd /c "schtasks /query /tn $TaskName >nul 2>nul"
  return ($LASTEXITCODE -eq 0)
}

function Start-Sandbox {
  $existing = Get-RunningProcess
  if ($existing) {
    Write-Host "Already running (pid $($existing.Id)) - $(Get-Url)/"
    return
  }

  $env:NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
  # Start-Process does not quote -ArgumentList: a path with a space in it
  # (C:\Users\First Last\...) would reach node as two arguments.
  $p = Start-Process -FilePath $Node `
                     -ArgumentList ('"{0}"' -f (Join-Path $App 'dist\server.js')) `
                     -WorkingDirectory $Here `
                     -WindowStyle Hidden `
                     -RedirectStandardOutput $LogOut `
                     -RedirectStandardError $LogErr `
                     -PassThru
  $p.Id | Set-Content -Path $PidFile -Encoding ascii
  Start-Sleep -Seconds 2

  if (Get-RunningProcess) {
    Write-Host "Started (pid $($p.Id))"
    Write-Host "  UI    $(Get-Url)/"
    Write-Host "  Logs  $LogOut"
  } else {
    Write-Host 'Failed to start. Last lines of the error log:' -ForegroundColor Red
    if (Test-Path $LogErr) { Get-Content $LogErr -Tail 20 }
    exit 1
  }
}

function Stop-Sandbox {
  $p = Get-RunningProcess
  if (-not $p) {
    Write-Host 'Not running.'
    Remove-Item $PidFile -ErrorAction SilentlyContinue
    return
  }
  Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
  Remove-Item $PidFile -ErrorAction SilentlyContinue
  Write-Host 'Stopped.'
}

function Get-Status {
  $p = Get-RunningProcess
  if ($p) { Write-Host "Running (pid $($p.Id)) - $(Get-Url)/" } else { Write-Host 'Stopped.' }
  if (Test-TaskRegistered) {
    Write-Host 'Autostart: registered (Task Scheduler)'
  } else {
    Write-Host 'Autostart: not registered'
  }
}

function Install-Service {
  $script = Join-Path $Here 'sapbah.ps1'
  $argLine = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$script`" start"

  # The ScheduledTasks cmdlets are used rather than schtasks.exe because the
  # /tr value would have to carry nested quotes (the script path is quoted
  # inside an already-quoted argument), which schtasks parses incorrectly.
  if (Get-Command Register-ScheduledTask -ErrorAction SilentlyContinue) {
    $action   = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argLine
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
                                             -DontStopIfGoingOnBatteries `
                                             -StartWhenAvailable `
                                             -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName $TaskName `
                           -Action $action -Trigger $trigger -Settings $settings `
                           -Description 'SAP Business Accelerator Hub sandbox' `
                           -Force | Out-Null
  } else {
    # Fallback for hosts without the ScheduledTasks module. schtasks needs the
    # inner quotes backslash-escaped.
    $escaped = $argLine -replace '"', '\"'
    cmd /c "schtasks /create /tn $TaskName /tr `"powershell.exe $escaped`" /sc onlogon /f >nul 2>nul"
    if ($LASTEXITCODE -ne 0) { Write-Error 'Could not register the scheduled task.' }
  }

  Write-Host 'Registered with Task Scheduler - starts when you log in.'
  Write-Host "  Task:   $TaskName"
  Write-Host '  Manage: taskschd.msc'
}

function Uninstall-Service {
  if (Get-Command Unregister-ScheduledTask -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  } else {
    cmd /c "schtasks /delete /tn $TaskName /f >nul 2>nul"
  }
  Write-Host 'Autostart removed.'
}

function Get-EnvValue([string]$Name, [string]$Default) {
  $envFile = Join-Path $Here '.env'
  if (Test-Path $envFile) {
    $m = Select-String -Path $envFile -Pattern "^$Name=(.*)$" | Select-Object -Last 1
    if ($m) {
      $v = $m.Matches[0].Groups[1].Value.Trim()
      if ($v) { return $v }
    }
  }
  return $Default
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

# major.minor.patch only; a pre-release suffix is ignored.
function ConvertTo-SemVer([string]$v) {
  $parts = @((($v -replace '^v', '') -split '[.+-]') | Select-Object -First 3 |
             ForEach-Object { [int]('0' + ($_ -replace '\D', '')) })
  while ($parts.Count -lt 3) { $parts += 0 }
  New-Object System.Version -ArgumentList $parts[0], $parts[1], $parts[2]
}

function Update-Sandbox {
  foreach ($a in $Rest) {
    if ($a -notin @('--auto', '--check', '--force')) { Write-Host "Unknown option: $a"; exit 1 }
  }
  $check = $Rest -contains '--check'
  $force = $Rest -contains '--force'
  if ($Rest -contains '--auto') {
    Write-Host ''
    Write-Host "=== $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') automatic update"
  }

  $repo = Get-EnvValue 'UPDATE_REPO' 'bdbais/sap-bah-sandbox'
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  $headers = @{ 'User-Agent' = 'sap-bah-sandbox'; 'Accept' = 'application/vnd.github+json' }

  $current = (Get-Content (Join-Path $App 'package.json') -Raw | ConvertFrom-Json).version
  try {
    $release = Invoke-RestMethod -Uri "https://api.github.com/repos/$repo/releases/latest" -Headers $headers -UseBasicParsing
  } catch {
    $status = $null
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    if ($status -eq 404) { Write-Host "No release of $repo has been published yet." }
    else { Write-Host "Could not get the latest release from GitHub: $($_.Exception.Message)" -ForegroundColor Red }
    exit 1
  }

  $tag    = [string]$release.tag_name
  $latest = $tag -replace '^v', ''
  if ($latest -notmatch '^\d+\.\d+\.\d+') { Write-Host "Unexpected release tag: '$tag'" -ForegroundColor Red; exit 1 }
  Write-Host "Installed: $current   Latest: $latest"

  if (-not $force -and -not ((ConvertTo-SemVer $latest) -gt (ConvertTo-SemVer $current))) {
    Write-Host 'Already up to date.'
    return
  }
  if ($check) {
    Write-Host "Update available: $($release.html_url)"
    Write-Host 'Install it with:   sapbah update'
    return
  }

  $work = Join-Path $env:TEMP ('sapbah_update_' + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $work | Out-Null
  $code = 1
  try {
    Write-Host "Downloading $tag..."
    $zip = Join-Path $work 'source.zip'
    Invoke-WebRequest -Uri "https://github.com/$repo/archive/refs/tags/$tag.zip" -OutFile $zip -UseBasicParsing -Headers @{ 'User-Agent' = 'sap-bah-sandbox' }
    & tar.exe -xf $zip -C $work
    if ($LASTEXITCODE -ne 0) { Expand-Archive -Path $zip -DestinationPath $work -Force }

    $src = Get-ChildItem $work -Directory | Select-Object -First 1
    $installer = $null
    if ($src) { $installer = Join-Path $src.FullName 'install\install.ps1' }
    if (-not $installer -or -not (Test-Path $installer)) { throw 'The downloaded release has no install\install.ps1.' }

    # The installer stops this sandbox, rebuilds it and starts it again,
    # keeping data\ and .env. The cache keeps the runtime download for next time.
    $installArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $installer, '-Dir', $Here)
    if (-not (Test-TaskRegistered)) { $installArgs += '-NoService' }
    $env:SAPBAH_CACHE = Join-Path $Here 'cache'
    & powershell.exe @installArgs
    $code = $LASTEXITCODE
  } catch {
    Write-Host "Update failed: $($_.Exception.Message)" -ForegroundColor Red
  } finally {
    Push-Location $env:TEMP
    try { Remove-Tree $work } finally { Pop-Location }
  }

  if ($code -eq 0) {
    Write-Host "Updated to $latest."
  } else {
    Write-Host 'Update failed - starting the installed version again.' -ForegroundColor Red
    Start-Sandbox
    exit 1
  }
}

function Invoke-Cli([string]$script) {
  $env:NODE_OPTIONS = '--disable-warning=ExperimentalWarning'
  Push-Location $Here
  try { & $Node (Join-Path $App $script) @Rest }
  finally { Pop-Location }
}

switch ($Command.ToLower()) {
  'start'   { Start-Sandbox }
  'stop'    { Stop-Sandbox }
  'restart' { Stop-Sandbox; Start-Sandbox }
  'status'  { Get-Status }
  'logs'    { if (Test-Path $LogOut) { Get-Content $LogOut -Tail 80 -Wait } else { Write-Host 'No log yet.' } }
  'open'    { Start-Process "$(Get-Url)/" }
  'sync'    { Invoke-Cli 'dist\cli\sync.js' }
  'test'    { Invoke-Cli 'dist\cli\test.js' }
  'update'  { Update-Sandbox }
  'service' {
    switch (($Rest | Select-Object -First 1)) {
      'install'   { Install-Service }
      'uninstall' { Uninstall-Service }
      default     { Write-Host 'Usage: sapbah service install|uninstall' }
    }
  }
  default {
    Write-Host ''
    Write-Host 'SAP BAH Sandbox'
    Write-Host ''
    Write-Host '  sapbah start | stop | restart | status'
    Write-Host '  sapbah logs                follow the log'
    Write-Host '  sapbah open                open the UI in a browser'
    Write-Host '  sapbah sync [--filter X] [--specs]'
    Write-Host '  sapbah test --mock <slug> [--read-only]'
    Write-Host '  sapbah update              install the latest release (--check: only look)'
    Write-Host '  sapbah service install     start automatically at logon'
    Write-Host '  sapbah service uninstall'
    Write-Host ''
    Write-Host "Config: $(Join-Path $Here '.env')"
    Write-Host "Data:   $Data"
  }
}
