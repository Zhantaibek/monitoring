# QUIK Server Monitor

Telegram-бот для круглосуточного мониторинга сервера QUIK (`172.23.10.82`) **в режиме только чтения**.
Работает как служба Windows прямо на сервере. Отслеживает процессы и службы QUIK, TCP-порты,
CPU, RAM, диски, uptime и критические события Windows. Шлёт уведомления только при смене состояния.

Бот **не** останавливает и не перезапускает QUIK, не меняет настройки Windows, сеть и firewall,
не устанавливает драйверы и не собирает торговые данные.

- Архитектура и механизмы: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- План тестирования: [docs/TESTING.md](docs/TESTING.md)

## Структура

```text
quik-server-monitor/
├── src/
│   ├── index.ts                    # запуск, корректное завершение, режим --once
│   ├── config/                     # загрузка и валидация .env и config.json (zod)
│   ├── core/                       # Monitoring Core: планировщик, подтверждение состояний, окна обслуживания
│   ├── monitoring/                 # system / process / service / network / eventlog мониторы
│   ├── bot/
│   │   ├── bot.ts                  # Telegraf, авторизация по Telegram ID, авто-переподключение
│   │   ├── commands/               # /status /processes /services /resources /network /history /uptime /help
│   │   └── notifications/          # формат сообщений, очередь доставки (outbox)
│   ├── database/                   # SQLite (node:sqlite): инциденты, события, состояние, очередь
│   ├── logger/                     # pino + ротация, вырезание токена из логов
│   ├── heartbeat/                  # задел для внешнего мониторинга
│   └── utils/                      # безопасный запуск системных утилит, время Asia/Bishkek
├── config/config.example.json
├── service/QuikMonitor.xml         # служба Windows (WinSW)
├── scripts/
│   ├── audit-server.ps1            # ЭТАП 1: read-only аудит сервера
│   ├── build-release.ps1           # сборка дистрибутива на ПК разработчика
│   ├── install-service.ps1         # установка службы
│   ├── uninstall-service.ps1
│   └── test-dummy-process.ps1      # тестовый процесс для этапа 4
├── data/  logs/  runtime/          # создаются при установке
└── .env.example
```

## Этап 1. Аудит сервера (ничего не меняет)

1. Скопируйте `scripts\audit-server.ps1` на сервер.
2. Запустите (желательно от администратора, чтобы видеть пути всех процессов):
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File .\audit-server.ps1 -CheckTelegram
   ```
   `-CheckTelegram` делает одно исходящее TCP-подключение к `api.telegram.org:443`.
   Если политика безопасности этого не допускает, запускайте без ключа.
3. Отчёт `quik-audit-*.txt` появится на рабочем столе. Просмотрите его и передайте разработчику.
   В нём нет командных строк процессов, аргументов служб, текстов журналов и IP клиентов.

По отчёту заполняются `processes`, `services`, `ports` и `maintenanceWindows` в `config.json`.

## Конфигурация

`config/config.json` создаётся копированием `config.example.json`. Пример заполнения;
имена ниже **условные**, реальные берутся из аудита:

```json
"processes": [
  { "label": "QUIK Server", "image": "<имя>.exe", "minInstances": 1 }
],
"services": [
  { "label": "QUIK Service", "name": "<короткое имя службы>" }
],
"ports": [
  { "label": "Клиентский порт", "port": 0, "mode": "listen" }
],
"maintenanceWindows": [
  { "label": "Плановый перезапуск", "days": ["mon","tue","wed","thu","fri"], "start": "03:00", "end": "03:30" }
]
```

| Параметр | Описание |
|---|---|
| `processes[].image` | имя .exe как в Диспетчере задач, без пути |
| `processes[].minInstances` | сколько экземпляров должно работать |
| `services[].name` | короткое имя службы (Name), не отображаемое |
| `ports[].mode` | `listen` — пассивно по `netstat` (рекомендуется для локальных портов QUIK, к QUIK не подключается); `connect` — TCP-подключение, для внешних узлов (шлюз биржи и т.п.) |
| `thresholds` | пороги CPU/RAM (> %) и свободного места на дисках (< %) |
| `confirm` | сколько проверок подряд нужно для подтверждения проблемы или восстановления |
| `disks` | какие диски проверять: `["C:\\", "D:\\"]` |
| `eventLog.sources` | журналы: `System` (уровни 1, 2); при желании `Application` с `providers: ["Application Error"]` для обнаружения падений приложений |
| `maintenanceWindows` | плановые работы: уведомления о процессах, службах и портах в это время не отправляются |

`.env` создаётся из `.env.example`: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_ID` и, если нужно,
`TELEGRAM_PROXY_URL`.

## Этап 5. Развёртывание

Предварительно:
- создайте бота у @BotFather, узнайте свой Telegram ID (@userinfobot) и напишите боту `/start`,
  иначе бот не сможет вам писать;
- скачайте portable Node.js 22 LTS (`node-v22.x.x-win-x64.zip` с nodejs.org) и проверьте SHA256
  по `SHASUMS256.txt`;
- скачайте WinSW v2.12.0 (`WinSW-x64.exe` с GitHub).

**На ПК разработчика:**
```powershell
.\scripts\build-release.ps1 -NodeZip C:\dl\node-v22.x.x-win-x64.zip -WinSWExe C:\dl\WinSW-x64.exe
```
Скрипт создаёт `release\quik-server-monitor.zip` и печатает его SHA256.

**На сервере** (от администратора, лучше в окно обслуживания):
1. Распакуйте архив, например в `C:\QuikMonitor\`, и сверьте SHA256 архива.
2. Создайте `.env` и `config\config.json`.
3. Выполните read-only проверку: `.\runtime\node.exe --disable-warning=ExperimentalWarning .\dist\index.js --once`.
4. Установите службу: `.\scripts\install-service.ps1 -Start`.
5. Проверьте сообщение «🔵 МОНИТОРИНГ ЗАПУЩЕН» и ответ на `/status`.
6. Выйдите из RDP (Sign out) и убедитесь, что `/status` по-прежнему отвечает.

Служба `QuikMonitor`:
- работает под `NT AUTHORITY\LocalService` и не зависит от RDP-сессии;
- запускается автоматически (отложенный старт) после загрузки Windows;
- перезапускается при сбое через 10, 30 и 60 с;
- при остановке корректно закрывает базу данных.

| Действие | Команда |
|---|---|
| Статус | `Get-Service QuikMonitor` |
| Перезапуск (после правки config) | `Restart-Service QuikMonitor` |
| Удаление | `.\scripts\uninstall-service.ps1` (история сохраняется) |
| Логи | `logs\monitor.*.log` (JSON, ротация по дням, 30 файлов) |

## Команды бота

| Команда | Что показывает |
|---|---|
| `/status` | общее состояние, QUIK, CPU, RAM, диски, активные проблемы, время последней проверки |
| `/processes` | процессы QUIK: PID, память, время простоя |
| `/services` | состояние служб |
| `/resources` | CPU, RAM, диски |
| `/network` | порты и связь с Telegram |
| `/history` | последние 15 инцидентов с длительностью |
| `/uptime` | uptime сервера, время загрузки, версия ОС, uptime бота |
| `/help` | список команд |

## Разработка

```powershell
npm install
npm run build
npm test
npm run check-once   # однократная проверка без Telegram
```
Требуется Node.js ≥ 22.13: в нём есть встроенный `node:sqlite`, нативные модули не нужны.
