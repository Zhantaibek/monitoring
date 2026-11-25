import path from 'node:path';
import { loadEnv } from './config.js';
import { createLogger, errMsg, registerSecret } from './logger.js';
import { queryService, stateRu, ServiceStore } from './services.js';
import { Watcher } from './watcher.js';
import { CommandBot, createSender, esc, formatTransition } from './bot.js';

/** Режим --once: однократная проверка служб без Telegram. */
async function runOnce(): Promise<void> {
  const env = loadEnv(false);
  const store = new ServiceStore(path.join(env.dataDir, 'services.json'), env.seedConfigPath);
  const list = store.list();
  if (list.length === 0) console.log('Список служб пуст. Добавьте службы командой /add в Telegram.');
  for (const s of list) console.log(`${s.label} (${s.name}): ${stateRu(await queryService(s.name))}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--once')) return runOnce();

  const env = loadEnv(true);
  registerSecret(env.botToken);
  const log = createLogger({ logDir: env.logDir, level: env.logLevel, console: process.stdout.isTTY === true });
  log.info({ pid: process.pid, node: process.version }, 'Запуск мониторинга');

  const store = new ServiceStore(path.join(env.dataDir, 'services.json'), env.seedConfigPath);
  const botOpts = { token: env.botToken, adminIds: env.adminIds, proxyUrl: env.proxyUrl, serverName: env.serverName, timezone: env.timezone, log };
  const send = createSender(botOpts);
  const notify = (html: string) => void send(html).catch((err) => log.error({ err: errMsg(err) }, 'Ошибка отправки'));

  const watcher = new Watcher(store, env.intervalSec, (t) => notify(formatTransition(t, env.serverName, env.timezone)), log);
  const bot = new CommandBot(botOpts, store, watcher);

  const count = store.list().length;
  notify(
    `🔵 <b>Мониторинг запущен</b>\nСервер: ${esc(env.serverName)}\nСлужб под наблюдением: ${count}` +
      (count === 0 ? '\n\nСписок пуст — добавьте службы: /add <code>имя</code>' : '\n\n/status — текущее состояние'),
  );

  watcher.start();
  bot.start();

  let shuttingDown = false;
  const shutdown = async (reason: string, code: number) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ reason }, 'Остановка мониторинга');
    setTimeout(() => process.exit(code), 10_000).unref();
    watcher.stop();
    await bot.stop();
    if (code === 0) await Promise.race([send(`⚪ <b>Мониторинг остановлен</b>\nСервер: ${esc(env.serverName)}`), new Promise((r) => setTimeout(r, 5000))]).catch(() => undefined);
    log.flush();
    setTimeout(() => process.exit(code), 300);
  };

  process.on('SIGINT', () => void shutdown('SIGINT', 0));
  process.on('SIGTERM', () => void shutdown('SIGTERM', 0));
  process.on('SIGBREAK', () => void shutdown('SIGBREAK', 0));
  process.on('uncaughtException', (err) => {
    log.fatal({ err: errMsg(err), stack: err.stack }, 'Необработанное исключение');
    void shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => log.error({ err: errMsg(reason) }, 'Необработанный rejection'));
}

main().catch((err) => {
  console.error(`FATAL: ${errMsg(err)}`);
  process.exit(1);
});
