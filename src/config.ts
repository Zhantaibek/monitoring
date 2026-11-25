import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Корень приложения: dist/config.js -> .. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export interface AppEnv {
  botToken: string;
  adminIds: number[];
  proxyUrl?: string;
  serverName: string;
  timezone: string;
  intervalSec: number;
  dataDir: string;
  logDir: string;
  logLevel: string;
  /** Старый config.json: из него один раз берётся начальный список служб. */
  seedConfigPath: string;
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(APP_ROOT, p);
}

/** Загружает .env. requireTelegram=false для режима --once. */
export function loadEnv(requireTelegram: boolean): AppEnv {
  const envFile = path.join(APP_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
  const e = process.env;

  const botToken = (e.TELEGRAM_BOT_TOKEN ?? '').trim();
  // Можно указать несколько админов через запятую: 111111,222222
  const adminIds = (e.TELEGRAM_ADMIN_ID ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);

  if (requireTelegram) {
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) throw new Error('TELEGRAM_BOT_TOKEN не задан или имеет неверный формат (.env)');
    if (adminIds.length === 0 || adminIds.some((id) => !Number.isSafeInteger(id) || id <= 0))
      throw new Error('TELEGRAM_ADMIN_ID не задан или содержит не число (.env)');
  }

  const timezone = e.TIMEZONE?.trim() || 'Asia/Bishkek';
  try {
    new Intl.DateTimeFormat('ru-RU', { timeZone: timezone });
  } catch {
    throw new Error(`Неизвестный часовой пояс TIMEZONE=${timezone}`);
  }

  const intervalSec = Number(e.CHECK_INTERVAL_SEC?.trim() || 30);
  if (!Number.isInteger(intervalSec) || intervalSec < 5) throw new Error('CHECK_INTERVAL_SEC должен быть целым числом ≥ 5');

  return {
    botToken,
    adminIds,
    proxyUrl: e.TELEGRAM_PROXY_URL?.trim() || undefined,
    serverName: e.SERVER_NAME?.trim() || 'QUIK Production',
    timezone,
    intervalSec,
    dataDir: resolveFromRoot(e.DATA_DIR?.trim() || 'data'),
    logDir: resolveFromRoot(e.LOG_DIR?.trim() || 'logs'),
    logLevel: e.LOG_LEVEL?.trim() || 'info',
    seedConfigPath: resolveFromRoot('config/config.json'),
  };
}
