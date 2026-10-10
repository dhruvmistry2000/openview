# Start OpenCode when it is not already listening, then run the Openview proxy
# in the foreground. Stopping this script stops only the OpenCode process it
# started. HOST, PORT, and OPENCODE_URL are passed through to server.mjs.
$ErrorActionPreference = "Stop"
if (Get-Variable -Name PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue) {
  $PSNativeCommandUseErrorActionPreference = $false
}

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

if (-not $env:HOST) { $env:HOST = "127.0.0.1" }
if (-not $env:PORT) { $env:PORT = "8080" }
if (-not $env:OPENCODE_URL) { $env:OPENCODE_URL = "http://127.0.0.1:4096" }

$BindHost = $env:HOST
$BindPort = [int]$env:PORT

function Test-Port {
  param(
    [string]$TargetHost,
    [int]$TargetPort
  )
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $wait = $client.BeginConnect($TargetHost, $TargetPort, $null, $null)
    $opened = $wait.AsyncWaitHandle.WaitOne(1000, $false)
    if (-not $opened) { return $false }
    $client.EndConnect($wait)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
}

function Get-ProbeHost {
  param([string]$Name)
  if ($Name -eq "0.0.0.0" -or $Name -eq "::" -or $Name -eq "") { return "127.0.0.1" }
  return $Name
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "node was not found on PATH. Openview needs Node.js."
  exit 1
}

$OpenCodeUrl = [Uri]$env:OPENCODE_URL
$OcHost = $OpenCodeUrl.Host
$OcPort = $OpenCodeUrl.Port
$OcLocal = $OcHost -in @("127.0.0.1", "localhost", "::1")
$UiHost = Get-ProbeHost $BindHost

if (Test-Port $UiHost $BindPort) {
  Write-Host "Openview is already running at http://${UiHost}:${BindPort}"
  exit 0
}

$OcProcess = $null
try {
  if ($OcLocal) {
    $OcProbe = Get-ProbeHost $OcHost
    if (Test-Port $OcProbe $OcPort) {
      Write-Host "OpenCode is already running at $($env:OPENCODE_URL)"
    } else {
      $ocCmd = Get-Command opencode -ErrorAction SilentlyContinue
      if (-not $ocCmd) {
        Write-Error "opencode was not found on PATH, and nothing is listening at $($env:OPENCODE_URL)."
        exit 1
      }
      $ocBind = "127.0.0.1"
      $logOut = Join-Path $env:TEMP "openview-opencode.out.log"
      $logErr = Join-Path $env:TEMP "openview-opencode.err.log"
      Write-Host "Starting OpenCode on http://${ocBind}:${OcPort}"
      $OcProcess = Start-Process -FilePath $ocCmd.Source -ArgumentList @(
        "serve", "--port", "$OcPort", "--hostname", $ocBind
      ) -PassThru -WindowStyle Hidden -RedirectStandardOutput $logOut -RedirectStandardError $logErr

      $ready = $false
      for ($i = 0; $i -lt 40; $i++) {
        if ($OcProcess.HasExited) {
          Write-Error "OpenCode exited before it accepted connections. Log: $logErr"
          if (Test-Path $logErr) { Get-Content $logErr -Tail 40 | Write-Host }
          exit 1
        }
        if (Test-Port $ocBind $OcPort) {
          $ready = $true
          break
        }
        Start-Sleep -Milliseconds 250
      }
      if (-not $ready) {
        Write-Error "OpenCode did not start listening on ${ocBind}:${OcPort}. Log: $logErr"
        if (Test-Path $logErr) { Get-Content $logErr -Tail 40 | Write-Host }
        exit 1
      }
    }
  }

  Write-Host "Starting Openview on http://${UiHost}:${BindPort}"
  & node server.mjs
} finally {
  if ($OcProcess -and -not $OcProcess.HasExited) {
    Stop-Process -Id $OcProcess.Id -Force -ErrorAction SilentlyContinue
  }
}
