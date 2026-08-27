param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 4184
$NodeExe = Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue
if (-not $NodeExe) { $NodeExe = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
$CodexExe = @(
  (Join-Path $env:USERPROFILE '.codex\plugins\.plugin-appserver\codex.exe'),
  (Join-Path $env:USERPROFILE '.codex\.sandbox-bin\codex.exe'),
  (Get-Command codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source -ErrorAction SilentlyContinue)
) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
if ($CodexExe) { $env:CODEX_EXE = $CodexExe }

if (-not (Test-Path -LiteralPath $NodeExe)) {
  Add-Type -AssemblyName PresentationFramework
  [System.Windows.MessageBox]::Show('Runtime not found. Please open or update Codex, then try again.','408 AI Mistake Assistant') | Out-Null
  exit 1
}

try {
  Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1 | Out-Null
} catch {
  Start-Process -FilePath $NodeExe -ArgumentList @((Join-Path $AppRoot 'server.mjs')) -WorkingDirectory $AppRoot -WindowStyle Hidden
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 350
    try { Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 1 | Out-Null; break } catch {}
  }
}
if (-not $NoBrowser) { Start-Process "http://127.0.0.1:$Port/" }
