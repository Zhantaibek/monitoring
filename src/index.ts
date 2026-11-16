import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { APP_ROOT, loadConfig, loadEnv, type AppConfig } from './config/index.js';
import { createLogger, errMsg, registerSecret, type Logger } from './logger/index.js';
import { setTimeZone, fmtDateTime, fmtDuration } from './utils/time.js';
import { Database } from './database/db.js';
import { MonitoringCore } from './core/monitoring-core.js';
import { SystemMonitor } from './monitoring/system.monitor.js';
import { ProcessMonitor } from './monitoring/process.monitor.js';
import { ServiceMonitor } from './monitoring/service.monitor.js';
import { NetworkMonitor } from './monitoring/network.monitor.js';
import { EventLogMonitor, type KeyValueStore } from './monitoring/eventlog.monitor.js';
import type { Monitor } from './monitoring/types.js';
import { Notifier } from './bot/notifications/notifier.js';
import { formatPlain } from './bot/notifications/formatter.js';
import { CommandBot, createSender } from './bot/bot.js';
import { Heartbeat } from './heartbeat/heartbeat.js';

const VERSION: string = (() => {
  try {
    return (JSON.parse(fs.readFileSync(path.join(APP_ROOT, 'package.json'), 'utf8')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
})();

function buildMonitors(cfg: AppConfig, kv: KeyValueStore): Monitor[] {
  return [new ProcessMonitor(cfg), new ServiceMonitor(cfg), new SystemMonitor(cfg), new NetworkMonitor(cfg), new EventLogMonitor(cfg, kv)];
}

/** Защита от двойного запуска. Lock-файл, созданный до последней загрузки ОС, считается устаревшим. */
function acquireLock(dataDir: string, log: Logger): () => void {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'monitor.lock');
  const bootTime = Date.now() - os.uptime() * 1000;
  if (fs.existsSync(file)) {
    try {
      const { pid, startedAt } = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number; startedAt: number };
      let alive = false;
      if (startedAt > bootTime && pid !== process.pid) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }
      if (alive) {
        log.fatal({ pid }, 'Монитор уже запущен (lock-файл активен). Выход.');
        process.exit(2);
      }
    } catch {
      /* повреждённый lock — перезаписываем */
    }
  }
  fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  return () => {
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  };
}

/** Режим --once: однократная проверка без Telegram и без записи в БД — для проверки конфигурации на сервере. */
async function runOnce(cfg: AppConfig): Promise<void> {
  const mem = new Map<string, string>();
  const kv: KeyValueStore = { get: (k) => mem.get(k), set: (k, v) => void mem.set(k, v) };
  const ctx = { currentLevel: () => 'OK' as const };
  for (const m of buildMonitors(cfg, kv)) {
    if (!m.enabled()) {
      console.log(`\n== ${m.name}: не настроен (пропущен)`);
      continue;
    }
    const started = Date.now();
    try {
      const out = await m.run(ctx);
      console.log(`\n== ${m.name} (${Date.now() - started} мс)`);
      console.log(JSON.stringify(out.snapshot, null, 2));
      for (const o of out.observations) console.log(`  [${o.level}] ${o.key} — ${o.subject[1]}`);
    } catch (err) {
      console.log(`\n== ${m.name}: ОШИБКА ${errMsg(err)}`);
    }
  }
}

async function main(): Promise<void> {
  const once = process.argv.includes('--once');
  const env = loadEnv(!once);
  registerSecret(env.botToken);
  const cfg = loadConfig(env.configPath);
  setTimeZone(cfg.timezone);

  if (once) {
    await runOnce(cfg);
    return;
  }

  const log = createLogger({ logDir: env.logDir, level: env.logLevel, console: process.stdout.isTTY === true });
  log.info({ version: VERSION, pid: process.pid, node: process.version }, 'Запуск мониторинга');
  const releaseLock = acquireLock(env.dataDir, log);

  const db = new Database(env.dataDir);
  const prevCleanShutdown = db.get('clean_shutdown');
  db.set('clean_shutdown', '0');

  const botOpts = { token: env.botToken, adminId: env.adminId, proxyUrl: env.proxyUrl, log };
  const notifier = new Notifier(db, createSender(botOpts), log);
  const core = new MonitoringCore(cfg, buildMonitors(cfg, db), db, notifier, log);
  const bot = new CommandBot(botOpts, { core, db, notifier, version: VERSION });
  const heartbeat = new Heartbeat(
    { dataDir: env.dataDir, intervalSec: cfg.heartbeat.intervalSec, url: env.heartbeatUrl, enabledPush: cfg.heartbeat.enabled },
    () => core.overall(),
    log,
  );

  // Сообщение о запуске
  const uptimeMs = os.uptime() * 1000;
  const startLines: [string, string][] = [
    ['Сервер', cfg.server.name],
    ['IP', cfg.server.ip],
    ['Время', fmtDateTime(Date.now())],
    ['Uptime сервера', fmtDuration(uptimeMs)],
    ['Версия', VERSION],
  ];
  if (uptimeMs < 15 * 60_000) startLines.push(['⚠️ Внимание', `сервер недавно перезагружен (${fmtDateTime(Date.now() - uptimeMs)})`]);
  if (prevCleanShutdown === '0') startLines.push(['⚠️ Внимание', 'предыдущая работа монитора завершилась аварийно']);
  if (cfg.processes.length === 0) startLines.push(['⚠️ Конфигурация', 'процессы QUIK не заданы']);
  const restored = core.tracker.problems().length;
  if (restored) startLines.push(['Активных проблем (из истории)', String(restored)]);
  db.enqueue(formatPlain('🔵', 'МОНИТОРИНГ ЗАПУЩЕН', startLines));

  notifier.start();
  core.start();
  bot.start();
  heartbeat.start();

  let shuttingDown = false;
  const shutdown = async (reason: string, code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'Остановка мониторинга');
    const hardExit = setTimeout(() => process.exit(code), 12_000);
    hardExit.unref();
    try {
      core.stop();
      heartbeat.stop();
      notifier.stop();
      await bot.stop();
      if (code === 0) {
        await notifier.sendDirect(
          formatPlain('⚪', 'МОНИТОРИНГ ОСТАНОВЛЕН', [
            ['Сервер', cfg.server.name],
            ['Время', fmtDateTime(Date.now())],
            ['Причина', 'штатная остановка службы'],
          ]),
          5000,
        );
        db.set('clean_shutdown', '1');
      }
    } catch (err) {
      log.error({ err: errMsg(err) }, 'Ошибка при остановке');
    } finally {
      db.close();
      releaseLock();
      log.flush();
      setTimeout(() => process.exit(code), 300);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK', 0));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: errMsg(err), stack: err.stack }, 'Необработанное исключение — перезапуск через службу');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    // Не завершаем процесс: логируем и продолжаем мониторинг
    log.error({ err: errMsg(reason) }, 'Необработанный rejection');
  });
}

main().catch((err) => {
  console.error(`FATAL: ${errMsg(err)}`);
  process.exit(1);
});
