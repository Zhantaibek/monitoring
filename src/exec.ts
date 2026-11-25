import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Единственная точка запуска внешних программ: только sc.exe из System32
 * и только операции чтения (query/queryex), локально или на удалённом сервере. Без shell, с таймаутом.
 */
const SC_EXE = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'sc.exe');
const READ_ONLY_VERBS = ['query', 'queryex'];

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/** Вывод sc.exe идёт в OEM-кодировке (cp866 на русской Windows). */
function decode(buf: Buffer): string {
  try {
    return new TextDecoder('ibm866').decode(buf);
  } catch {
    return buf.toString('latin1');
  }
}

/** Имя компьютера или IPv4-адрес — без пробелов и спецсимволов. */
export function isValidHost(host: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host);
}

/** host — удалённый компьютер (sc \\host ...); пусто — локальный. */
export function runSc(args: string[], timeoutMs = 15_000, host?: string): Promise<ExecResult> {
  if (!READ_ONLY_VERBS.includes((args[0] ?? '').toLowerCase())) {
    return Promise.reject(new Error(`Запрещённая операция: sc ${args[0] ?? ''}`));
  }
  if (host !== undefined && !isValidHost(host)) return Promise.reject(new Error(`Недопустимое имя сервера: ${host}`));
  const fullArgs = host ? [`\\\\${host}`, ...args] : args;
  return new Promise((resolve, reject) => {
    execFile(
      SC_EXE,
      fullArgs,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', shell: false },
      (err, stdout) => {
        const out = decode(stdout as Buffer);
        if (err) {
          const e = err as NodeJS.ErrnoException & { code?: number | string; killed?: boolean };
          if (typeof e.code === 'number') return resolve({ stdout: out, exitCode: e.code });
          return reject(new Error(`sc: ${e.killed ? `таймаут ${timeoutMs} мс` : e.message}`));
        }
        resolve({ stdout: out, exitCode: 0 });
      },
    );
  });
}
