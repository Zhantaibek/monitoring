import { errMsg, type Logger } from './logger.js';
import { queryService, stateRu, type ServiceState, type ServiceStore, type WatchedService } from './services.js';

/** Сколько проверок подряд нужно, чтобы считать службу упавшей или восстановленной (защита от ложных срабатываний). */
export const CONFIRM_CHECKS = 2;

interface Tracked {
  state: ServiceState;
  down: boolean;
  /** Сколько проверок подряд состояние расходится с подтверждённым */
  streak: number;
  /** Когда началось расхождение */
  changeStartedAt?: number;
  downSince?: number;
}

export interface ServiceView extends WatchedService {
  state?: ServiceState;
  down: boolean;
}

export type Transition = { kind: 'down'; service: WatchedService; state: ServiceState; at: number } | { kind: 'up'; service: WatchedService; at: number; downSince: number };

/** Применяет результат одной проверки. Возвращает событие, если состояние подтвердилось. */
export function applyCheck(t: Tracked, state: ServiceState, now: number, service: WatchedService): Transition | undefined {
  t.state = state;
  const ok = state === 'RUNNING';
  if (ok !== t.down) {
    // совпадает с подтверждённым состоянием
    t.streak = 0;
    t.changeStartedAt = undefined;
    return undefined;
  }
  if (t.streak === 0) t.changeStartedAt = now;
  t.streak++;
  if (t.streak < CONFIRM_CHECKS) return undefined;

  const at = t.changeStartedAt ?? now;
  t.streak = 0;
  t.changeStartedAt = undefined;
  t.down = !ok;
  if (t.down) {
    t.downSince = at;
    return { kind: 'down', service, state, at };
  }
  const downSince = t.downSince ?? at;
  t.downSince = undefined;
  return { kind: 'up', service, at, downSince };
}

export function newTracked(): Tracked {
  return { state: 'UNKNOWN', down: false, streak: 0 };
}

/** Периодически проверяет все службы из списка и сообщает о падении/восстановлении. */
export class Watcher {
  private tracked = new Map<string, Tracked>();
  private timer?: NodeJS.Timeout;
  private running = false;
  lastCheckAt?: number;

  constructor(
    private readonly store: ServiceStore,
    private readonly intervalSec: number,
    private readonly onTransition: (t: Transition) => void,
    private readonly log: Logger,
  ) {}

  start(): void {
    const tick = async () => {
      await this.checkAll();
      if (this.timer !== undefined) this.timer = setTimeout(tick, this.intervalSec * 1000);
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  async checkAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const s of this.store.list()) {
        let state: ServiceState;
        try {
          state = await queryService(s.name);
        } catch (err) {
          this.log.warn({ service: s.name, err: errMsg(err) }, 'Не удалось опросить службу');
          state = 'UNKNOWN';
        }
        const key = s.name.toLowerCase();
        let t = this.tracked.get(key);
        if (!t) {
          t = newTracked();
          this.tracked.set(key, t);
        }
        const ev = applyCheck(t, state, Date.now(), s);
        if (ev) {
          this.log.info({ service: s.name, event: ev.kind, state: stateRu(state) }, 'Смена состояния службы');
          this.onTransition(ev);
        }
      }
      this.lastCheckAt = Date.now();
    } finally {
      this.running = false;
    }
  }

  forget(name: string): void {
    this.tracked.delete(name.toLowerCase());
  }

  view(): ServiceView[] {
    return this.store.list().map((s) => {
      const t = this.tracked.get(s.name.toLowerCase());
      return { ...s, state: t?.state, down: t?.down ?? false };
    });
  }
}
