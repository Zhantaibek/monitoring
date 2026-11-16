import path from 'node:path';
import { pino, type Logger } from 'pino';

export type { Logger };

let secrets: string[] = [];

/** Регистрирует строки, которые никогда не должны попасть в логи (токен бота и т.п.). */
export function registerSecret(value: string | undefined): void {
  if (value && value.length >= 8) secrets.push(value);
}

/** Убирает секреты из произвольной строки (сообщения об ошибках сетевых библиотек содержат URL с токеном). */
export function redact(text: string): string {
  let out = text;
  for (const s of secrets) out = out.split(s).join('***');
  // На случай если токен попал в URL до регистрации
  return out.replace(/bot\d+:[A-Za-z0-9_-]{30,}/g, 'bot***');
}

/** Безопасное представление ошибки для логов и сообщений. */
export function errMsg(err: unknown): string {
  if (err instanceof Error) return redact(err.message).slice(0, 500);
  return redact(String(err)).slice(0, 500);
}

export function createLogger(opts: { logDir: string; level: string; console: boolean }): Logger {
  const targets: pino.TransportTargetOptions[] = [
    {
      target: 'pino-roll',
      level: opts.level,
      options: {
        file: path.join(opts.logDir, 'monitor'),
        extension: '.log',
        frequency: 'daily',
        dateFormat: 'yyyy-MM-dd',
        size: '20m',
        mkdir: true,
        limit: { count: 30 },
      },
    },
  ];
  if (opts.console) targets.push({ target: 'pino/file', level: opts.level, options: { destination: 1 } });

  return pino(
    {
      level: opts.level,
      base: { app: 'quik-monitor' },
      timestamp: pino.stdTimeFunctions.isoTime,
      hooks: { streamWrite: (s: string) => redact(s) },
    },
    pino.transport({ targets }),
  );
}
