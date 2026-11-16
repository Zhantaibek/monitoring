import fs from 'node:fs';
import path from 'node:path';
import { errMsg, type Logger } from '../logger/index.js';
import type { Level } from '../monitoring/types.js';

/**
 * Точка интеграции с внешним мониторингом (этап 8).
 *
 * 1) Всегда: data/heartbeat.json обновляется каждые intervalSec — признак «живости» процесса.
 * 2) Опционально: исходящий HTTP GET на HEARTBEAT_URL (push / dead man's switch).
 *    Внешний сервер (например, Uptime Kuma во внутренней сети) поднимает тревогу,
 *    если heartbeat не приходит — это покрывает отключение питания, зависание ОС,
 *    потерю сети и падение самого бота. Входящие порты на сервере QUIK не открываются.
 */
export class Heartbeat {
  private timer?: NodeJS.Timeout;
  private failures = 0;

  constructor(
    private readonly opts: { dataDir: string; intervalSec: number; url?: string; enabledPush: boolean },
    private readonly status: () => Level,
    private readonly log: Logger,
  ) {}

  start(): void {
    void this.beat();
    this.timer = setInterval(() => void this.beat(), this.opts.intervalSec * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async beat(): Promise<void> {
    const level = this.status();
    const payload = { ts: Date.now(), iso: new Date().toISOString(), status: level, pid: process.pid };
    try {
      const file = path.join(this.opts.dataDir, 'heartbeat.json');
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(payload));
      fs.renameSync(`${file}.tmp`, file);
    } catch (err) {
      this.log.warn({ err: errMsg(err) }, 'Не удалось записать heartbeat.json');
    }

    if (!this.opts.enabledPush || !this.opts.url) return;
    try {
      const u = new URL(this.opts.url);
      // heartbeat — признак живости бота; уровень проблем передаётся информационно
      u.searchParams.set('status', 'up');
      u.searchParams.set('msg', level);
      const res = await fetch(u, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.failures = 0;
    } catch (err) {
      if (++this.failures === 1 || this.failures % 30 === 0) this.log.warn({ err: errMsg(err), failures: this.failures }, 'Heartbeat не доставлен');
    }
  }
}
