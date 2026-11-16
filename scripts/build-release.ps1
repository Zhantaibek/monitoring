<#
.SYNOPSIS
  Сборка дистрибутива на машине разработчика (НЕ на боевом сервере).

.DESCRIPTION
  1. npm ci + сборка TypeScript + модульные тесты.
  2. Копирует в release\quik-server-monitor только необходимое: dist (без тестов),
     production node_modules (чистый JS, без нативных модулей), config, scripts, service, docs.
  3. Опционально распаковывает portable Node.js (zip с nodejs.org) в runtime\.
  4. Создаёт zip и выводит SHA256 для контроля целостности при переносе на сервер.

.PARAMETER NodeZip
  Путь к node-v22.x.x-win-x64.zip (https://nodejs.org/dist/). Проверьте SHA256 по SHASUMS256.txt.
.PARAMETER WinSWExe
  Путь к WinSW-x64.exe v2.12.0 (https://github.com/winsw/winsw/releases/tag/v2.12.0).
#>
param(
  [string]$NodeZip,
  [string]$WinSWExe
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$out = Join-Path $root 'release\quik-server-monitor'

Push-Location $root
try {
  npm ci; if ($LASTEXITCODE) { throw 'npm ci' }
  npm test; if ($LASTEXITCODE) { throw 'tests failed' }

  if (Test-Path (Join-Path $root 'release')) { Remove-Item (Join-Path $root 'release') -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $out | Out-Null

  Copy-Item dist $out -Recurse
  Get-ChildItem (Join-Path $out 'dist') -Recurse -Include '*.test.js', '*.test.js.map' | Remove-Item -Force
  Remove-Item (Join-Path $out 'dist\tests') -Recurse -Force -ErrorAction SilentlyContinue
  foreach ($f in 'package.json', 'package-lock.json', '.env.example', 'README.md') { Copy-Item $f $out }
  foreach ($d in 'config', 'scripts', 'service', 'docs') { Copy-Item $d $out -Recurse }
  Remove-Item (Join-Path $out 'config\config.json') -ErrorAction SilentlyContinue
  Remove-Item (Join-Path $out 'scripts\build-release.ps1')

  Push-Location $out
  npm ci --omit=dev --ignore-scripts; if ($LASTEXITCODE) { throw 'npm ci --omit=dev' }
  Pop-Location

  if ($NodeZip) {
    $tmp = Join-Path $env:TEMP ("node-extract-" + [guid]::NewGuid())
    Expand-Archive $NodeZip $tmp
    $nodeDir = Get-ChildItem $tmp -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path (Join-Path $out 'runtime') | Out-Null
    Copy-Item (Join-Path $nodeDir.FullName 'node.exe') (Join-Path $out 'runtime\node.exe')
    Remove-Item $tmp -Recurse -Force
  }
  if ($WinSWExe) { Copy-Item $WinSWExe (Join-Path $out 'service\QuikMonitor.exe') }

  $zip = Join-Path $root 'release\quik-server-monitor.zip'
  Compress-Archive -Path $out -DestinationPath $zip
  $hash = (Get-FileHash $zip -Algorithm SHA256).Hash
  Write-Host "Готово: $zip"
  Write-Host "SHA256: $hash"
} finally {
  Pop-Location
}
