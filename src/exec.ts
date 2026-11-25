import { execFile } from 'node:child_process';
import path from 'node:path';

/**
 * Единственная точка запуска внешних программ: только sc.exe из System32
 * и только операции чтения (query/queryex). Без shell, с таймаутом.
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

export function runSc(args: string[], timeoutMs = 15_000): Promise<ExecResult> {
  if (!READ_ONLY_VERBS.includes((args[0] ?? '').toLowerCase())) {
    return Promise.reject(new Error(`Запрещённая операция: sc ${args[0] ?? ''}`));
  }
  return new Promise((resolve, reject) => {
    execFile(
      SC_EXE,
      args,
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
