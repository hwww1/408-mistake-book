param(
  [string]$Destination = '',
  [switch]$NoShortcut,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$PackageRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProgramSource = Join-Path $PackageRoot '程序'
$SourceCodeSource = Join-Path $PackageRoot '项目源码'

if (-not (Test-Path -LiteralPath $ProgramSource)) {
  $RepositoryRoot = Split-Path -Parent $PackageRoot
  $RepositoryCompanion = Join-Path $RepositoryRoot 'companion'
  if (Test-Path -LiteralPath $RepositoryCompanion) {
    $ProgramSource = $RepositoryCompanion
    $SourceCodeSource = $RepositoryRoot
  } else {
    throw '安装包不完整：没有找到“程序”或“companion”文件夹。请重新下载完整仓库。'
  }
}

if (-not $Destination) {
  $drive = Get-PSDrive -PSProvider FileSystem |
    Where-Object { $_.Root -and $_.Free -gt 2GB } |
    Sort-Object Free -Descending |
    Select-Object -First 1
  if (-not $drive) { throw '没有找到剩余空间大于 2GB 的磁盘。' }
  $Destination = Join-Path $drive.Root '408AI错题助手'
}

$ProgramDestination = Join-Path $Destination '程序'
$SourceCodeDestination = Join-Path $Destination '项目源码'
New-Item -ItemType Directory -Path $ProgramDestination -Force | Out-Null
Copy-Item -Path (Join-Path $ProgramSource '*') -Destination $ProgramDestination -Recurse -Force

if (Test-Path -LiteralPath $SourceCodeSource) {
  New-Item -ItemType Directory -Path $SourceCodeDestination -Force | Out-Null
  Copy-Item -Path (Join-Path $SourceCodeSource '*') -Destination $SourceCodeDestination -Recurse -Force
}

$OneDriveRoot = $env:OneDrive
if (-not $OneDriveRoot) { $OneDriveRoot = $env:OneDriveConsumer }
if (-not $OneDriveRoot) { $OneDriveRoot = Join-Path $env:USERPROFILE 'OneDrive' }
$DataRoot = Join-Path $OneDriveRoot '408AI错题助手数据'
New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null

$LauncherScriptPath = Join-Path $Destination 'start-408-assistant.ps1'
$EscapedDataRoot = $DataRoot.Replace("'", "''")
$EscapedStartPath = (Join-Path $ProgramDestination 'start.ps1').Replace("'", "''")
$LauncherScriptLines = @(
  ('$env:CS408_ASSISTANT_DATA = ''{0}''' -f $EscapedDataRoot),
  ('& ''{0}''' -f $EscapedStartPath)
)
Set-Content -LiteralPath $LauncherScriptPath -Value $LauncherScriptLines -Encoding UTF8

$LauncherPath = Join-Path $Destination '启动408错题助手.cmd'
$LauncherLines = @(
  '@echo off',
  'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-408-assistant.ps1"'
)
Set-Content -LiteralPath $LauncherPath -Value $LauncherLines -Encoding ASCII

if (-not $NoShortcut) {
  $Desktop = [Environment]::GetFolderPath('Desktop')
  $ShortcutPath = Join-Path $Desktop '408 AI 错题助手.lnk'
  $Shell = New-Object -ComObject WScript.Shell
  $Shortcut = $Shell.CreateShortcut($ShortcutPath)
  $Shortcut.TargetPath = $LauncherPath
  $Shortcut.WorkingDirectory = $Destination
  $Shortcut.Description = '启动 408 AI 错题助手'
  $Shortcut.Save()
}

Write-Host ''
Write-Host '安装完成。' -ForegroundColor Green
Write-Host "程序位置：$ProgramDestination"
Write-Host "Codex 项目源码：$SourceCodeDestination"
Write-Host "OneDrive 错题数据：$DataRoot"
Write-Host '以后双击桌面的“408 AI 错题助手”即可。'

if (-not $NoStart) {
  Start-Process -FilePath $LauncherPath
}
