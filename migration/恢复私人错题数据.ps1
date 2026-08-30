param(
  [Parameter(Mandatory = $true)]
  [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'
$ResolvedArchive = (Resolve-Path -LiteralPath $ArchivePath).Path
$OneDriveRoot = $env:OneDrive
if (-not $OneDriveRoot) { $OneDriveRoot = $env:OneDriveConsumer }
if (-not $OneDriveRoot) { $OneDriveRoot = Join-Path $env:USERPROFILE 'OneDrive' }
$DataRoot = Join-Path $OneDriveRoot '408AI错题助手数据'

if (Test-Path -LiteralPath $DataRoot) {
  $BackupRoot = Join-Path $OneDriveRoot ("408AI错题助手数据-恢复前备份-{0}" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Copy-Item -LiteralPath $DataRoot -Destination $BackupRoot -Recurse -Force
  Write-Host "原有数据已备份到：$BackupRoot"
}

New-Item -ItemType Directory -Path $DataRoot -Force | Out-Null
Expand-Archive -LiteralPath $ResolvedArchive -DestinationPath $DataRoot -Force

$Snapshot = Join-Path $DataRoot 'mistakes.snapshot.json'
if (-not (Test-Path -LiteralPath $Snapshot)) {
  throw '压缩包中没有 mistakes.snapshot.json，数据恢复未完成。'
}

Write-Host ''
Write-Host '私人错题数据恢复完成。' -ForegroundColor Green
Write-Host "数据位置：$DataRoot"
Write-Host '请重新启动桌面的“408 AI 错题助手”。'

