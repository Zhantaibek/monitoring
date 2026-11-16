import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Корень приложения: dist/config/index.js -> ../.. */
export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const pct = z.number().min(0).max(100);
const label = z.string().trim().min(1).max(64);

const ProcessSchema = z.object({
  label,
  // Имя исполняемого файла, как в Диспетчере задач (например, "something.exe")
  image: z.string().trim().regex(/^[^\\/:*?"<>|]+\.exe$/i, 'ожидается имя .exe без пути'),
  minInstances: z.number().int().min(1).default(1),
});

const ServiceSchema = z.object({
  label,
  // Короткое имя службы (Name, не DisplayName)
  name: z.string().trim().regex(/^[A-Za-z0-9_.\- $]{1,256}$/, 'недопустимое имя службы'),
});

const PortSchema = z.object({
  label,
  host: z.string().trim().default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
  // listen  — пассивно: порт в состоянии LISTENING (netstat), без подключения к QUIK
  // connect — активно: TCP-подключение и немедленное закрытие (для внешних узлов)
  mode: z.enum(['listen', 'connect']).default('listen'),
  timeoutMs: z.number().int().min(500).max(30000).default(3000),
});

const DayEnum = z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']);
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'формат HH:MM');

const MaintenanceSchema = z.object({
  label,
  days: z.array(DayEnum).min(1),
  start: hhmm,
  end: hhmm,
  suppress: z.array(z.enum(['process', 'service', 'port'])).default(['process', 'service', 'port']),
});

const EventSourceSchema = z.object({
  log: z.enum(['System', 'Application']),
  levels: z.array(z.number().int().min(1).max(3)).min(1).default([1, 2]),
  providers: z.array(z.string().trim().min(1)).default([]),
  ignoreEventIds: z.array(z.number().int()).default([]),
});

export const ConfigSchema = z
  .object({
    server: z
      .object({ name: z.string().default('QUIK Production'), ip: z.string().default('172.23.10.82') })
      .prefault({}),
    timezone: z.string().default('Asia/Bishkek'),
    intervals: z
      .object({
        processSec: z.number().int().min(5).default(15),
        serviceSec: z.number().int().min(10).default(30),
        systemSec: z.number().int().min(10).default(30),
        networkSec: z.number().int().min(10).default(30),
        eventLogSec: z.number().int().min(60).default(300),
      })
      .prefault({}),
    confirm: z
      .object({
        failChecks: z.number().int().min(1).max(20).default(2),
        recoverChecks: z.number().int().min(1).max(20).default(2),
        resourceChecks: z.number().int().min(1).max(20).default(3),
      })
      .prefault({}),
    thresholds: z
      .object({
        cpu: z.object({ warning: pct.default(85), critical: pct.default(95) }).prefault({}),
        ram: z.object({ warning: pct.default(85), critical: pct.default(95) }).prefault({}),
        diskFree: z.object({ warning: pct.default(15), critical: pct.default(5) }).prefault({}),
        hysteresis: z.number().min(0).max(20).default(5),
        diskHysteresis: z.number().min(0).max(10).default(1),
      })
      .prefault({}),
    disks: z.array(z.string().regex(/^[A-Za-z]:\\?$/, 'ожидается "C:\\"')).default(['C:\\']),
    processes: z.array(ProcessSchema).default([]),
    services: z.array(ServiceSchema).default([]),
    ports: z.array(PortSchema).default([]),
    eventLog: z
      .object({
        enabled: z.boolean().default(true),
        sources: z.array(EventSourceSchema).prefault([{ log: 'System', levels: [1, 2] }]),
        maxItemsInAlert: z.number().int().min(1).max(20).default(5),
      })
      .prefault({}),
    maintenanceWindows: z.array(MaintenanceSchema).default([]),
    history: z.object({ retentionDays: z.number().int().min(7).max(3650).default(180) }).prefault({}),
    heartbeat: z
      .object({ enabled: z.boolean().default(false), intervalSec: z.number().int().min(30).default(60) })
      .prefault({}),
  })
  .superRefine((c, ctx) => {
    for (const k of ['cpu', 'ram'] as const) {
      if (c.thresholds[k].warning >= c.thresholds[k].critical)
        ctx.addIssue({ code: 'custom', path: ['thresholds', k], message: 'warning должен быть меньше critical' });
    }
    if (c.thresholds.diskFree.warning <= c.thresholds.diskFree.critical)
      ctx.addIssue({ code: 'custom', path: ['thresholds', 'diskFree'], message: 'warning должен быть больше critical' });
    try {
      new Intl.DateTimeFormat('ru-RU', { timeZone: c.timezone });
    } catch {
      ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'неизвестный часовой пояс' });
    }
  });

export type AppConfig = z.infer<typeof ConfigSchema>;
export type ProcessConfig = z.infer<typeof ProcessSchema>;
export type ServiceConfig = z.infer<typeof ServiceSchema>;
export type PortConfig = z.infer<typeof PortSchema>;
export type MaintenanceWindow = z.infer<typeof MaintenanceSchema>;
export type EventSourceConfig = z.infer<typeof EventSourceSchema>;

export interface AppEnv {
  botToken: string;
  adminId: number;
  proxyUrl?: string;
  heartbeatUrl?: string;
  configPath: string;
  dataDir: string;
  logDir: string;
  logLevel: string;
}

function resolveFromRoot(p: string): string {
  return path.isAbsolute(p) ? p : path.join(APP_ROOT, p);
}

/** Загружает .env (если есть). requireTelegram=false для режима --once. */
export function loadEnv(requireTelegram: boolean): AppEnv {
  const envFile = path.join(APP_ROOT, '.env');
  if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

  const e = process.env;
  const botToken = (e.TELEGRAM_BOT_TOKEN ?? '').trim();
  const adminRaw = (e.TELEGRAM_ADMIN_ID ?? '').trim();
  const adminId = Number(adminRaw);

  if (requireTelegram) {
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(botToken)) throw new Error('TELEGRAM_BOT_TOKEN не задан или имеет неверный формат (.env)');
    if (!/^\d{3,15}$/.test(adminRaw) || !Number.isSafeInteger(adminId)) throw new Error('TELEGRAM_ADMIN_ID не задан или не является числом (.env)');
  }

  return {
    botToken,
    adminId,
    proxyUrl: e.TELEGRAM_PROXY_URL?.trim() || undefined,
    heartbeatUrl: e.HEARTBEAT_URL?.trim() || undefined,
    configPath: resolveFromRoot(e.CONFIG_PATH?.trim() || 'config/config.json'),
    dataDir: resolveFromRoot(e.DATA_DIR?.trim() || 'data'),
    logDir: resolveFromRoot(e.LOG_DIR?.trim() || 'logs'),
    logLevel: e.LOG_LEVEL?.trim() || 'info',
  };
}

export function loadConfig(configPath: string): AppConfig {
  if (!fs.existsSync(configPath)) {
    throw new Error(`Файл конфигурации не найден: ${configPath}. Скопируйте config/config.example.json в config/config.json`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`Ошибка разбора JSON в ${configPath}: ${(err as Error).message}`);
  }
  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Некорректная конфигурация ${configPath}:\n${issues}`);
  }
  return parsed.data;
}
