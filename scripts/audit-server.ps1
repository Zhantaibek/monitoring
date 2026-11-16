<#
.SYNOPSIS
  READ-ONLY аудит сервера QUIK перед установкой мониторинга (Этап 1).

.DESCRIPTION
  Скрипт ничего не изменяет: не останавливает процессы, не меняет службы,
  реестр, файлы QUIK, firewall или сеть. Только чтение через стандартные
  командлеты Windows. Результат — текстовый отчёт, который нужно передать
  разработчику для заполнения config.json.

  НЕ собирается: командные строки процессов (могут содержать пароли),
  пути запуска служб с аргументами, содержимое журналов событий,
  удалённые IP-адреса клиентов, файлы конфигурации QUIK.

.PARAMETER OutFile
  Путь к отчёту. По умолчанию — рабочий стол текущего пользователя.

.PARAMETER CheckTelegram
  Дополнительно проверить исходящее TCP-подключение к api.telegram.org:443
  (одно подключение, без передачи данных). По умолчанию выключено.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\audit-server.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\audit-server.ps1 -CheckTelegram
#>
[CmdletBinding()]
param(
  [string]$OutFile = (Join-Path ([Environment]::GetFolderPath('Desktop')) ("quik-audit-{0}.txt" -f (Get-Date -Format 'yyyyMMdd-HHmmss'))),
  [switch]$CheckTelegram
)

$ErrorActionPreference = 'Continue'
$report = New-Object System.Collections.Generic.List[string]

function Add-Section([string]$title) {
  $report.Add('')
  $report.Add(('=' * 78))
  $report.Add("== $title")
  $report.Add(('=' * 78))
}

function Add-Block($obj) {
  if ($null -eq $obj) { $report.Add('(нет данных)'); return }
  $text = ($obj | Format-Table -AutoSize -Wrap | Out-String -Width 220).TrimEnd()
  if ([string]::IsNullOrWhiteSpace($text)) { $report.Add('(нет данных)') } else { $report.Add($text) }
}

function Try-Run([string]$title, [scriptblock]$block) {
  Add-Section $title
  try { & $block } catch { $report.Add("ОШИБКА: $($_.Exception.Message)") }
}

# Признаки, по которым ищем кандидатов QUIK. Это ТОЛЬКО подсказка для человека —
# окончательные имена выбираются вручную по отчёту.
$quikPattern = 'quik|arqa|info\.exe|infoserver|qserver|quikserver'

$report.Add("QUIK server audit (read-only)")
$report.Add("Дата: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$report.Add("Компьютер: $env:COMPUTERNAME")
$report.Add("Пользователь аудита: $env:USERDOMAIN\$env:USERNAME")
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$report.Add("Запущено с правами администратора: $isAdmin (не обязательно; без них часть путей процессов может быть скрыта)")

Try-Run '1. Операционная система' {
  $os = Get-CimInstance Win32_OperatingSystem
  $cs = Get-CimInstance Win32_ComputerSystem
  Add-Block ([pscustomobject]@{
    Caption        = $os.Caption
    Version        = $os.Version
    Build          = $os.BuildNumber
    Arch           = $os.OSArchitecture
    Locale         = (Get-Culture).Name
    OEMCodePage    = [Console]::OutputEncoding.CodePage
    LastBoot       = $os.LastBootUpTime
    UptimeHours    = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
    RAM_GB         = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
    LogicalCPUs    = $cs.NumberOfLogicalProcessors
    Domain         = $cs.Domain
    PartOfDomain   = $cs.PartOfDomain
  })
  $report.Add("PowerShell: $($PSVersionTable.PSVersion)")
  $tz = Get-TimeZone -ErrorAction SilentlyContinue
  if ($tz) { $report.Add("Часовой пояс сервера: $($tz.Id) ($($tz.DisplayName))") }
}

Try-Run '2. Диски (локальные)' {
  Add-Block (Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object DeviceID, VolumeName, FileSystem,
    @{n='Size_GB';e={[math]::Round($_.Size/1GB,1)}},
    @{n='Free_GB';e={[math]::Round($_.FreeSpace/1GB,1)}},
    @{n='Free_%';e={ if ($_.Size) { [math]::Round(100*$_.FreeSpace/$_.Size,1) } }})
}

Try-Run '3. Текущая нагрузка (один замер)' {
  $cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
  $os = Get-CimInstance Win32_OperatingSystem
  $ramPct = [math]::Round(100 * (1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize), 1)
  $report.Add("CPU: $cpu %   RAM: $ramPct %")
}

$procs = $null
Try-Run '4. Кандидаты процессов QUIK (по имени/пути)' {
  # Без CommandLine — она может содержать пароли
  $script:procs = Get-CimInstance Win32_Process | Select-Object Name, ProcessId, ParentProcessId, ExecutablePath, CreationDate,
    @{n='WS_MB';e={[math]::Round($_.WorkingSetSize/1MB,0)}}, SessionId
  $cand = $script:procs | Where-Object { $_.Name -match $quikPattern -or $_.ExecutablePath -match $quikPattern }
  if ($cand) { Add-Block ($cand | Sort-Object Name) } else { $report.Add('Совпадений по шаблону не найдено — см. полный список ниже (раздел 5).') }
}

Try-Run '5. Все процессы НЕ из каталога Windows (имя, путь, память)' {
  $nonSystem = $script:procs | Where-Object { $_.ExecutablePath -and $_.ExecutablePath -notmatch '^[A-Z]:\\Windows\\' } |
    Sort-Object Name | Select-Object Name, ProcessId, ExecutablePath, WS_MB, SessionId, CreationDate
  Add-Block $nonSystem
  $report.Add('')
  $report.Add('Процессы без доступного пути (нужны права администратора), только имена:')
  $report.Add((($script:procs | Where-Object { -not $_.ExecutablePath } | Select-Object -ExpandProperty Name | Sort-Object -Unique) -join ', '))
}

Try-Run '6. Службы Windows, НЕ являющиеся стандартными (бинарник вне C:\Windows)' {
  # PathName используется только для фильтра и НЕ выводится (может содержать аргументы)
  $svc = Get-CimInstance Win32_Service | Where-Object { $_.PathName -and $_.PathName -notmatch '(?i)\\Windows\\(system32|syswow64|servicing|Microsoft\.NET)\\' }
  Add-Block ($svc | Sort-Object Name | Select-Object Name, DisplayName, State, StartMode, StartName, ProcessId)
  $report.Add('')
  $report.Add('Службы, совпадающие с шаблоном QUIK по имени/описанию:')
  Add-Block (Get-CimInstance Win32_Service | Where-Object { $_.Name -match $quikPattern -or $_.DisplayName -match $quikPattern } | Select-Object Name, DisplayName, State, StartMode)
}

Try-Run '7. Слушающие TCP-порты и процессы-владельцы' {
  $byPid = @{}
  foreach ($p in $script:procs) { $byPid[[int]$p.ProcessId] = $p.Name }
  if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
    $listen = Get-NetTCPConnection -State Listen | Select-Object LocalAddress, LocalPort, OwningProcess,
      @{n='Process';e={ $byPid[[int]$_.OwningProcess] }} | Sort-Object LocalPort -Unique
    Add-Block $listen
    $report.Add('')
    $report.Add('Количество установленных соединений по локальному порту (без удалённых адресов):')
    Add-Block (Get-NetTCPConnection -State Established | Group-Object LocalPort | Sort-Object Count -Descending |
      Select-Object -First 25 @{n='LocalPort';e={$_.Name}}, Count,
      @{n='Process';e={ $byPid[[int]($_.Group[0].OwningProcess)] }})
  } else {
    $report.Add((netstat -ano -p TCP | Select-String -Pattern '0\.0\.0\.0:0|\[::\]:0' | Out-String))
  }
}

Try-Run '8. Планировщик задач (не Microsoft) — возможные плановые перезапуски QUIK' {
  if (Get-Command Get-ScheduledTask -ErrorAction SilentlyContinue) {
    $tasks = Get-ScheduledTask | Where-Object { $_.TaskPath -notmatch '^\\Microsoft\\' }
    $rows = foreach ($t in $tasks) {
      $info = $t | Get-ScheduledTaskInfo -ErrorAction SilentlyContinue
      [pscustomobject]@{
        Name     = $t.TaskName
        Path     = $t.TaskPath
        State    = $t.State
        RunAs    = $t.Principal.UserId
        Exe      = ($t.Actions | ForEach-Object { $_.Execute }) -join '; '
        LastRun  = $info.LastRunTime
        NextRun  = $info.NextRunTime
        Triggers = ($t.Triggers | ForEach-Object { $_.CimClass.CimClassName -replace 'MSFT_Task','' -replace 'Trigger','' }) -join ','
      }
    }
    Add-Block $rows
  } else {
    $report.Add('Get-ScheduledTask недоступен')
  }
}

Try-Run '9. Журнал System: Critical/Error за 7 дней (только источник и код, без текста)' {
  $ev = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Level = 1, 2; StartTime = (Get-Date).AddDays(-7) } -MaxEvents 5000 -ErrorAction SilentlyContinue
  if ($ev) {
    Add-Block ($ev | Group-Object ProviderName, Id | Sort-Object Count -Descending | Select-Object -First 30 Count, Name)
  } else { $report.Add('Событий нет или нет доступа.') }
  $report.Add('')
  $report.Add('Неожиданные выключения/перезагрузки за 30 дней (Kernel-Power 41, EventLog 6008), только время:')
  $sd = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 6008; StartTime = (Get-Date).AddDays(-30) } -MaxEvents 50 -ErrorAction SilentlyContinue
  if ($sd) { Add-Block ($sd | Select-Object TimeCreated, ProviderName, Id) } else { $report.Add('нет') }
}

Try-Run '10. Сбои приложений за 30 дней (Application Error 1000), только имя приложения' {
  $ae = Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = (Get-Date).AddDays(-30) } -MaxEvents 500 -ErrorAction SilentlyContinue
  if ($ae) {
    Add-Block ($ae | ForEach-Object { [pscustomobject]@{ App = $_.Properties[0].Value; Time = $_.TimeCreated } } |
      Group-Object App | Sort-Object Count -Descending | Select-Object Count, Name, @{n='Last';e={ ($_.Group | Sort-Object Time -Descending | Select-Object -First 1).Time }})
  } else { $report.Add('нет') }
}

Try-Run '11. Готовность к установке мониторинга' {
  $node = Get-Command node -ErrorAction SilentlyContinue
  $report.Add("Node.js в PATH: $(if ($node) { "$($node.Source) $(& node --version)" } else { 'нет (будет использована портативная копия в папке приложения)' })")
  $report.Add('WinHTTP proxy:')
  $report.Add((netsh winhttp show proxy | Out-String).Trim())
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($ie) { $report.Add("User proxy: enabled=$($ie.ProxyEnable) server=$($ie.ProxyServer)") }
  $av = Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct -ErrorAction SilentlyContinue
  if ($av) { $report.Add("Антивирус: $(($av | Select-Object -ExpandProperty displayName) -join ', ')") }
  $report.Add("Defender: $(try { (Get-MpComputerStatus -ErrorAction Stop).AMServiceEnabled } catch { 'н/д' })")
  $applocker = Get-Service AppIDSvc -ErrorAction SilentlyContinue
  if ($applocker) { $report.Add("AppLocker (AppIDSvc): $($applocker.Status)") }
  if ($CheckTelegram) {
    $r = Test-NetConnection api.telegram.org -Port 443 -WarningAction SilentlyContinue
    $report.Add("api.telegram.org:443 -> TcpTestSucceeded=$($r.TcpTestSucceeded) RemoteAddress=$($r.RemoteAddress)")
  } else {
    $report.Add('Проверка api.telegram.org:443 не выполнялась (запустите с -CheckTelegram).')
  }
}

$report | Out-File -FilePath $OutFile -Encoding UTF8
Write-Host "Отчёт сохранён: $OutFile"
Write-Host 'Проверьте отчёт перед передачей: в нём не должно быть секретов.'
