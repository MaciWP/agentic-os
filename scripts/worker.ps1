# The Agentic OS worker on Windows, behind its shortcuts.
#   start    runs the server under scripts/supervise.ts with no window, makes sure the hub can
#            reach it (scripts/remote-setup.ts ensure: the Tailscale Serve route), and opens it.
#            A server or supervisor left without the other is stopped first: nothing would bring
#            it back after a restart or an update.
#   stop     ends the supervisor and the server; the PTY host stays, so terminals survive.
#   logs     sends the logs to the hub by Taildrop, for when the server is down. With it up, the
#            hub reads them at /api/machines/<id>/system/logs. A failed start sends them too.
#   install  -Hub <the Mac's Tailscale name>: shortcuts on the desktop and in the Start menu, and
#            `start -NoBrowser` in the Startup folder, so the hub finds the PC after a reboot
#            (ensure waits for Tailscale to connect). No admin rights needed.
# Light on purpose: this PC also games. A click is one health call and one process query, and
# nothing but the worker is left running.
param(
  [ValidateSet("start", "stop", "logs", "install")][string]$Action = "start",
  [string]$Hub,
  # At logon the worker starts without opening a browser window.
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$App = Split-Path $PSScriptRoot -Parent
if (-not $env:AGENTIC_OS_DATA) { $env:AGENTIC_OS_DATA = "C:\agentic-os\data" }
$Data = $env:AGENTIC_OS_DATA
# 127.0.0.1, never localhost: the server listens on IPv4 only, and Windows tries ::1 first and
# takes about 2 s to give up on it.
$Url = "http://127.0.0.1:4317"
$PidFile = Join-Path $Data "supervisor.pid"
$LauncherLog = Join-Path $Data "launcher.log"
$ServerLog = Join-Path $Data "server.log"
$LogMax = 10MB

function Log([string]$Line) {
  Add-Content $LauncherLog "$(Get-Date -Format 'yyyy-MM-ddTHH:mm:ss') [$Action] $Line" -Encoding UTF8
}

# A shortcut has no window to print to.
function Say([string]$Text, [int]$Icon = 64, [int]$Seconds = 0) {
  (New-Object -ComObject WScript.Shell).Popup($Text, $Seconds, "Agentic OS", $Icon) | Out-Null
}

function Find-Exe([string]$Name, [string]$Fallback) {
  $found = (Get-Command $Name -ErrorAction SilentlyContinue).Source
  if ($found) { $found } else { $Fallback }
}
$Bun = Find-Exe "bun" (Join-Path $env:USERPROFILE ".bun\bin\bun.exe")

# A native program's output, stderr included, and its exit code. Windows PowerShell turns
# stderr into errors, which $ErrorActionPreference = "Stop" would make fatal.
function Run-Native([string]$Exe, [string[]]$Arguments) {
  $ErrorActionPreference = "Continue"
  $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
  [pscustomobject]@{ Code = $LASTEXITCODE; Out = ($out -join "`n") }
}

function Healthy {
  try { $null -ne (Invoke-RestMethod "$Url/api/health" -TimeoutSec 3).pid } catch { $false }
}

# This app's Bun processes by what they run, from one process query.
function Worker-Processes {
  $app = $App.Replace("\", "/").ToLower()
  $all = Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" |
    Where-Object { $_.CommandLine } |
    ForEach-Object { [pscustomobject]@{ Id = [int]$_.ProcessId; Cmd = $_.CommandLine.Replace("\", "/").ToLower() } }
  [pscustomobject]@{
    Supervisors = @($all | Where-Object { $_.Cmd -like "*scripts/supervise.ts*" } | ForEach-Object Id)
    Servers = @($all | Where-Object { $_.Cmd -like "*$app/server/index.ts*" -or $_.Cmd -like "* server/index.ts*" } | ForEach-Object Id)
    Hosts = @($all | Where-Object { $_.Cmd -like "*server/host/main.ts*" } | ForEach-Object Id)
  }
}

function Stop-Ids([int[]]$Ids) {
  foreach ($id in $Ids) { Stop-Process -Id $id -Force -ErrorAction SilentlyContinue }
  foreach ($id in $Ids) { Wait-Process -Id $id -Timeout 10 -ErrorAction SilentlyContinue }
}

# Only one start or stop at a time: a double click must not start two supervisors.
function With-Lock([scriptblock]$Body) {
  $mutex = New-Object System.Threading.Mutex($false, "Local\AgenticOSWorkerLauncher")
  if (-not $mutex.WaitOne(0)) { Log "another launcher is running; nothing to do"; return }
  try { & $Body } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}

function Send-Logs {
  $hub = [Environment]::GetEnvironmentVariable("AGENTIC_OS_HUB", "User")
  if (-not $hub) { return "falta el nombre del Mac: ejecuta install con -Hub" }
  $file = Join-Path $env:TEMP "agentic-os-pc-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"
  $hostLog = Join-Path $Data "pty-host.log"
  $parts = foreach ($log in $LauncherLog, $ServerLog, $hostLog) {
    "===== $(Split-Path $log -Leaf)"
    Get-Content $log -Tail 200 -ErrorAction SilentlyContinue
  }
  $parts | Set-Content $file -Encoding UTF8
  $tailscale = Find-Exe "tailscale" (Join-Path $env:ProgramFiles "Tailscale\tailscale.exe")
  $r = Run-Native $tailscale @("file", "cp", $file, "${hub}:")
  Remove-Item $file -ErrorAction SilentlyContinue
  if ($r.Code -ne 0) { return "tailscale file cp ha fallado: $($r.Out)" }
  Log "logs sent to $hub"
  $null
}

function Start-Worker {
  $p = Worker-Processes
  Log "bun=$Bun supervisors=$($p.Supervisors -join ',') servers=$($p.Servers -join ',') hosts=$($p.Hosts -join ',')"
  $supervised = $p.Supervisors.Count -eq 1 -and (Healthy)
  if (-not $supervised) {
    # Whatever runs now cannot be trusted to come back: start over, keeping the PTY host.
    if ($p.Supervisors.Count -or $p.Servers.Count) {
      Log "stopping $(($p.Supervisors + $p.Servers) -join ',')"
      Stop-Ids ($p.Supervisors + $p.Servers)
      Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
    }
    # Kept small here, while no process has it open.
    if ((Test-Path $ServerLog) -and (Get-Item $ServerLog).Length -gt $LogMax) {
      Move-Item $ServerLog "$ServerLog.1" -Force
    }
    # cmd appends, so the server's own rotation (copy, then truncate) keeps working.
    $line = "`"`"$Bun`" scripts\supervise.ts >> `"$ServerLog`" 2>&1`""
    $cmd = Start-Process cmd.exe -ArgumentList "/d /s /c $line" -WorkingDirectory $App -WindowStyle Hidden -PassThru
    Log "started the supervisor (cmd $($cmd.Id))"
    $deadline = (Get-Date).AddSeconds(60)
    while (-not (Healthy)) {
      if ($cmd.HasExited) { throw "el supervisor ha terminado nada más arrancar (código $($cmd.ExitCode))" }
      if ((Get-Date) -gt $deadline) { throw "el worker no responde en $Url tras 60 s" }
      Start-Sleep -Milliseconds 500
    }
    Log "the server answers"
  }
  # The hub reaches this PC through Tailscale Serve; a reinstall or a logout drops the route.
  $r = Run-Native $Bun @((Join-Path $App "scripts\remote-setup.ts"), "ensure")
  Log "remote-setup ensure ($($r.Code)): $($r.Out)"
  if (-not $NoBrowser) { Start-Process "http://localhost:4317" }
  if ($r.Code -ne 0) { Say "El worker funciona, pero el Mac no podrá llegar a él:`n$($r.Out)" 48 }
}

function Stop-Worker {
  $p = Worker-Processes
  # The supervisor first, or it would start the server again; Windows does not stop its child.
  Stop-Ids $p.Supervisors
  Stop-Ids $p.Servers
  Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
  Log "stopped supervisors=$($p.Supervisors -join ',') servers=$($p.Servers -join ',')"
  if ($p.Supervisors.Count -or $p.Servers.Count) { Say "Worker parado. Los terminales siguen vivos." 64 3 }
  else { Say "El worker no estaba en marcha." 64 3 }
}

function Install-Shortcuts {
  if ($Hub) { [Environment]::SetEnvironmentVariable("AGENTIC_OS_HUB", $Hub, "User") }
  [Environment]::SetEnvironmentVariable("AGENTIC_OS_DATA", $Data, "User")
  $shell = New-Object -ComObject WScript.Shell
  $ps = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  $desktop = [Environment]::GetFolderPath("Desktop")
  Remove-Item (Join-Path $desktop "Agentic OS worker.lnk") -ErrorAction SilentlyContinue
  $shortcuts = @(
    @{ Name = "Agentic OS"; Action = "start" },
    @{ Name = "Parar Agentic OS"; Action = "stop" },
    @{ Name = "Enviar logs de Agentic OS"; Action = "logs" }
  )
  $places = @(
    @{ Dir = $desktop; Shortcuts = $shortcuts },
    @{ Dir = [Environment]::GetFolderPath("Programs"); Shortcuts = $shortcuts },
    @{ Dir = [Environment]::GetFolderPath("Startup"); Shortcuts = @(@{ Name = "Agentic OS"; Action = "start -NoBrowser" }) }
  )
  foreach ($place in $places) {
    $dir = $place.Dir
    foreach ($s in $place.Shortcuts) {
      $lnk = $shell.CreateShortcut((Join-Path $dir "$($s.Name).lnk"))
      $lnk.TargetPath = $ps
      $lnk.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$PSCommandPath`" $($s.Action)"
      $lnk.WorkingDirectory = $App
      $lnk.IconLocation = "$(Join-Path $App 'bin\agentic-os.ico'),0"
      # Minimized: the moment PowerShell needs to hide itself shows nothing.
      $lnk.WindowStyle = 7
      $lnk.Save()
    }
  }
  "Accesos creados en el escritorio y en el menú Inicio; el worker arranca solo al iniciar sesión. Logs por Taildrop a: $([Environment]::GetEnvironmentVariable('AGENTIC_OS_HUB', 'User'))"
}

try {
  switch ($Action) {
    "start" { With-Lock { Start-Worker } }
    "stop" { With-Lock { Stop-Worker } }
    "logs" {
      $why = Send-Logs
      if ($why) { Say "No se han podido enviar los logs: $why" 16 } else { Say "Logs enviados al Mac." 64 3 }
    }
    "install" { Install-Shortcuts }
  }
} catch {
  Log "failed: $($_.Exception.Message) $($_.InvocationInfo.PositionMessage)"
  if ($Action -eq "install") { throw }
  $why = Send-Logs
  $sent = if ($why) { "No se han podido enviar los logs: $why" } else { "Logs enviados al Mac." }
  Say "Agentic OS ha fallado: $($_.Exception.Message)`n`n$sent`nEn el PC: $LauncherLog" 16
}
