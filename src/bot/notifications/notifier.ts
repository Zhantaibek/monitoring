import type { Database } from '../../database/db.js';
import { errMsg, type Logger } from '../../logger/index.js';
import { fmtDateTime, fmtDuration } from '../../utils/time.js';

export type SendFn = (text: string) => Promise<void>;

interface TelegramLikeError {
  code?: number;
  response?: { error_code?: number; parameters?: { retry_after?: number } };
}

/**
 * Надёжная доставка уведомлений: каждое сообщение сначала сохраняется в SQLite (outbox),
 * затем отправляется. При отсутствии связи сообщения ждут и уходят после восстановления
 * с пометкой о задержке. Переживает перезапуск приложения.
 */
export class Notifier {
  private flushing = false;
  private timer?: NodeJS.Timeout;
  private offlineSince: number | null = null;
  private lastError: string | null = null;
  private lastSuccess: number | null = null;

  constructor(
    private readonly db: Database,
    private readonly send: SendFn,
    private readonly log: Logger,
  ) {}

  start(): void {
    this.timer = setInterval(() => void this.flush(), 10_000);
    void this.flush();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  enqueue(text: string): void {
    this.db.enqueue(text);
    void this.flush();
  }

  status(): { online: boolean; offlineSince: number | null; lastError: string | null; lastSuccess: number | null; pending: number } {
    return {
      online: this.offlineSince === null,
      offlineSince: this.offlineSince,
      lastError: this.lastError,
      lastSuccess: this.lastSuccess,
      pending: this.db.pendingCount(),
    };
  }

  /** Отправка напрямую, минуя очередь (для сообщения при остановке). */
  async sendDirect(text: string, timeoutMs: number): Promise<boolean> {
    try {
      await Promise.race([this.send(text), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), timeoutMs))]);
      return true;
    } catch {
      return false;
    }
  }

  async flush(): Promise<void> {
    if (this.flushing) return;
    this.flushing = true;
    try {
      for (;;) {
        const now = Date.now();
        const batch = this.db.pendingOutbox(now, 10);
        if (batch.length === 0) break;
        for (const item of batch) {
          const delayed = now - item.created_at > 60_000;
          const text = delayed
            ? `${item.text}\n\n⏳ <i>Доставлено с задержкой: событие зафиксировано ${fmtDateTime(item.created_at)}</i>`
            : item.text;
          try {
            await this.send(text);
            this.db.markSent(item.id);
            this.onSuccess();
            await new Promise((r) => setTimeout(r, 300)); // бережём лимиты Telegram
          } catch (err) {
            const stop = this.onFailure(item.id, item.attempts, err);
            if (stop) return;
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private onSuccess(): void {
    this.lastSuccess = Date.now();
    this.lastError = null;
    if (this.offlineSince !== null) {
      const downtime = Date.now() - this.offlineSince;
      this.offlineSince = null;
      this.log.info({ downtimeMs: downtime }, 'Связь с Telegram восстановлена');
      if (downtime > 120_000) {
        this.db.enqueue(
          `🟡 <b>СВЯЗЬ С TELEGRAM ВОССТАНОВЛЕНА</b>\n\nСвязь отсутствовала: ${fmtDuration(downtime)}\nОтложенные уведомления отправлены выше.`,
        );
      }
      this.db.retryNow();
    }
  }

  /** @returns true — прекратить отправку пачки (нет связи) */
  private onFailure(id: number, attempts: number, err: unknown): boolean {
    const e = err as TelegramLikeError;
    const code = e.response?.error_code ?? (typeof e.code === 'number' ? e.code : undefined);
    const msg = errMsg(err);
    this.lastError = msg;
    const now = Date.now();

    if (code === 429) {
      const wait = (e.response?.parameters?.retry_after ?? 5) * 1000;
      this.db.markAttemptFailed(id, msg, now + wait, false);
      return true;
    }
    if (code !== undefined && code >= 400 && code < 500) {
      // Ошибка запроса (неверный chat id, разметка, бот заблокирован) — повтор не поможет
      const permanent = attempts + 1 >= 3;
      this.db.markAttemptFailed(id, msg, now + 30_000, permanent);
      this.log.error({ code, err: msg, permanent }, 'Telegram отклонил сообщение');
      return false;
    }
    // Сетевая ошибка/5xx — экспоненциальная пауза, сообщение остаётся в очереди
    if (this.offlineSince === null) {
      this.offlineSince = now;
      this.log.warn({ err: msg }, 'Нет связи с Telegram, сообщения поставлены в очередь');
    }
    const backoff = Math.min(300_000, 5_000 * 2 ** Math.min(attempts, 6));
    this.db.markAttemptFailed(id, msg, now + backoff, false);
    return true;
  }
}
