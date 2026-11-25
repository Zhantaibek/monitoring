<#
.SYNOPSIS
  Установка службы QuikMonitor (Этап 5). Запускать от администратора.

.DESCRIPTION
  Что делает скрипт (и ничего больше):
    1. Проверяет наличие файлов приложения, portable Node.js, WinSW, .env.
    2. Выполняет однократную проверку служб из списка (dist\index.js --once).
    3. Назначает права ТОЛЬКО на папку приложения: служба может писать в data\ и logs\,
       .env читают только Administrators, SYSTEM и учётная запись службы.
    4. Регистрирует службу QuikMonitor (WinSW) с автозапуском и перезапуском при сбое.
    5. Назначает учётную запись службы (по умолчанию NT AUTHORITY\LocalService — минимум прав).

  НЕ изменяет: QUIK, его службы и файлы, firewall, сеть, PATH, реестр вне записи службы,
  не устанавливает драйверы и не перезагружает сервер.

.PARAMETER Start
  Сразу запустить службу после установки.
#>
#Requires -RunAsAdministrator
[CmdletBinding()]
param(
  [string]$ServiceAccount = 'NT AUTHORITY\LocalService',
  [switch]$Start
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$svcId = 'QuikMonitor'
$node = Join-Path $root 'runtime\node.exe'
$winsw = Join-Path $root 'service\QuikMonitor.exe'

function Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "ОШИБКА: $m" -ForegroundColor Red; exit 1 }

Step 'Проверка файлов'
foreach ($p in @($node, $winsw, (Join-Path $root 'service\QuikMonitor.xml'), (Join-Path $root 'dist\index.js'), (Join-Path $root '.env'),(Join-Path $root 'node_modules'))) {
  if (-not (Test-Path $p)) { Fail "не найден $p" }
}
$ver = (& $node --version).Trim()
if ($ver -notmatch '^v(\d+)\.(\d+)') { Fail "не удалось определить версию Node.js: $ver" }
if ([int]$Matches[1] -lt 22 -or ([int]$Matches[1] -eq 22 -and [int]$Matches[2] -lt 13)) { Fail "нужен Node.js >= 22.13, найден $ver" }
Write-Host "Node.js $ver"

if (Get-Service -Name $svcId -ErrorAction SilentlyContinue) { Fail "служба $svcId уже существует. Для переустановки сначала выполните uninstall-service.ps1" }

Step 'Read-only проверка конфигурации (--once)'
& $node --disable-warning=ExperimentalWarning (Join-Path $root 'dist\index.js') --once
if ($LASTEXITCODE -ne 0) { Fail 'проверка конфигурации завершилась с ошибкой' }

Step 'Права на папку приложения'
$sid = (New-Object System.Security.Principal.NTAccount($ServiceAccount)).Translate([System.Security.Principal.SecurityIdentifier]).Value
foreach ($d in @('data', 'logs')) { New-Item -ItemType Directory -Force -Path (Join-Path $root $d) | Out-Null }
# Наследуемые права (OI)(CI) распространяются на вложенные файлы автоматически
icacls $root /grant "*${sid}:(OI)(CI)RX" /C /Q | Out-Null
icacls (Join-Path $root 'data') /grant "*${sid}:(OI)(CI)M" /C /Q | Out-Null
icacls (Join-Path $root 'logs') /grant "*${sid}:(OI)(CI)M" /C /Q | Out-Null
$envFile = Join-Path $root '.env'
icacls $envFile /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' "*${sid}:R" /C /Q | Out-Null

Step 'Регистрация службы'
& $winsw install
if ($LASTEXITCODE -ne 0) { Fail 'WinSW install завершился с ошибкой' }
# Учётная запись службы (пустой пароль для встроенных LocalService/NetworkService)
$wmiSvc = Get-CimInstance Win32_Service -Filter "Name='$svcId'"
$r = Invoke-CimMethod -InputObject $wmiSvc -MethodName Change -Arguments @{ StartName = $ServiceAccount; StartPassword = '' }
if ($r.ReturnValue -ne 0) { Fail "не удалось назначить учётную запись службы (код $($r.ReturnValue))" }
# Отложенный автозапуск: после старта сети и служб QUIK
sc.exe config $svcId start= delayed-auto | Out-Null
# Перезапуск при сбое: 10 с, 30 с, 60 с; счётчик сбрасывается через сутки
sc.exe failure $svcId reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
sc.exe failureflag $svcId 1 | Out-Null

Get-Service $svcId | Format-List Name, DisplayName, Status, StartType
if ($Start) {
  Step 'Запуск службы'
  Start-Service $svcId
  Start-Sleep -Seconds 5
  Get-Service $svcId | Format-List Name, Status
  Write-Host 'Проверьте сообщение «МОНИТОРИНГ ЗАПУЩЕН» в Telegram и логи в папке logs\.'
} else {
  Write-Host "Служба установлена, но не запущена. Запуск: Start-Service $svcId"
}
