<#
.SYNOPSIS
  Тестовый процесс для Этапа 4 — имитирует «процесс QUIK», не затрагивая боевой QUIK.

.DESCRIPTION
  -Start : копирует системный PING.EXE в data\test\quikmon-dummy.exe и запускает его
           в фоне (ping -t 127.0.0.1). Имя процесса: quikmon-dummy.exe
  -Stop  : завершает ТОЛЬКО процессы quikmon-dummy.exe, запущенные из data\test\.

  Для теста добавьте в config.json:
    "processes": [ { "label": "TEST dummy", "image": "quikmon-dummy.exe" } ]
#>
param([switch]$Start, [switch]$Stop)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dir = Join-Path $root 'data\test'
$exe = Join-Path $dir 'quikmon-dummy.exe'

if ($Start) {
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  if (-not (Test-Path $exe)) { Copy-Item (Join-Path $env:SystemRoot 'System32\PING.EXE') $exe }
  $p = Start-Process -FilePath $exe -ArgumentList '-t', '127.0.0.1' -WindowStyle Hidden -PassThru
  Write-Host "Тестовый процесс запущен: PID $($p.Id)"
} elseif ($Stop) {
  $targets = Get-CimInstance Win32_Process -Filter "Name = 'quikmon-dummy.exe'" | Where-Object { $_.ExecutablePath -eq $exe }
  if (-not $targets) { Write-Host 'Тестовый процесс не запущен.'; exit 0 }
  foreach ($t in $targets) { Stop-Process -Id $t.ProcessId -Force; Write-Host "Остановлен тестовый процесс PID $($t.ProcessId)" }
} else {
  Write-Host 'Использование: test-dummy-process.ps1 -Start | -Stop'
}
