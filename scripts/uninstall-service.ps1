<#
.SYNOPSIS
  Остановка и удаление службы QuikMonitor. Данные (data\) и логи (logs\) сохраняются.
  Не затрагивает QUIK.
#>
#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$svc = Get-Service -Name 'QuikMonitor' -ErrorAction SilentlyContinue
if (-not $svc) { Write-Host 'Служба QuikMonitor не установлена.'; exit 0 }
if ($svc.Status -ne 'Stopped') { Stop-Service -Name 'QuikMonitor'; $svc.WaitForStatus('Stopped', (New-TimeSpan -Seconds 30)) }
& (Join-Path $root 'service\QuikMonitor.exe') uninstall
Write-Host 'Служба удалена. История событий сохранена в data\monitor.db.'
