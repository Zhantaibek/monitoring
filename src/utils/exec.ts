import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Единственная точка запуска внешних программ.
 * Разрешены только read-only системные утилиты Windows из System32, без shell,
 * с таймаутом и ограничением объёма вывода.
 */
const SYSTEM32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');

const ALLOWED = {
  tasklist: 'tasklist.exe', // список процессов
  sc: 'sc.exe', // ТОЛЬКО query/queryex (проверяется ниже)
  netstat: 'NETSTAT.EXE', // слушающие порты
  wevtutil: 'wevtutil.exe', // ТОЛЬКО qe (чтение журнала)
} as const;

export type AllowedCommand = keyof typeof ALLOWED;

const READ_ONLY_VERBS: Partial<Record<AllowedCommand, string[]>> = {
  sc: ['query', 'queryex'],
  wevtutil: ['qe'],
};

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/** Декодирует вывод консольной утилиты: UTF-16LE (если есть BOM или много нулевых байт), иначе latin1 (ASCII-часть не искажается). */
export function decodeOutput(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  let zeros = 0;
  const sample = Math.min(buf.length, 512);
  for (let i = 0; i < sample; i++) if (buf[i] === 0) zeros++;
  if (sample > 0 && zeros / sample > 0.3) return buf.toString('utf16le');
  return buf.toString('latin1');
}

export function runSystemCommand(cmd: AllowedCommand, args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  const verbs = READ_ONLY_VERBS[cmd];
  if (verbs && !verbs.includes((args[0] ?? '').toLowerCase())) {
    return Promise.reject(new Error(`Запрещённая операция: ${cmd} ${args[0] ?? ''}`));
  }
  const exe = path.join(SYSTEM32, ALLOWED[cmd]);
  return new Promise((resolve, reject) => {
    execFile(
      exe,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', shell: false },
      (err, stdout) => {
        const out = decodeOutput(stdout as Buffer);
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          if (typeof e.code === 'number') return resolve({ stdout: out, exitCode: e.code });
          return reject(new Error(`${cmd}: ${e.killed ? `таймаут ${timeoutMs} мс` : e.message}`));
        }
        resolve({ stdout: out, exitCode: 0 });
      },
    );
  });
}
