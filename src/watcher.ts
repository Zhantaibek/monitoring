import type { Logger } from './logger.js';
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

/** host=true — событие о самом сервере (недоступен / снова доступен), service.name = адрес сервера. */
export type Transition =
  | { kind: 'down'; service: WatchedService; state: ServiceState; at: number; host?: boolean }
  | { kind: 'up'; service: WatchedService; at: number; downSince: number; host?: boolean };

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
  /** Доступность удалённого сервера (только при TARGET_HOST) */
  private hostTracked = newTracked();
  private timer?: NodeJS.Timeout;
  private running = false;
  lastCheckAt?: number;

  constructor(
    private readonly store: ServiceStore,
    private readonly intervalSec: number,
    private readonly onTransition: (t: Transition) => void,
    private readonly log: Logger,
    private readonly host?: string,
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

  private emit(ev: Transition | undefined, state: ServiceState): void {
    if (!ev) return;
    this.log.info({ target: ev.service.name, host: ev.host ?? false, event: ev.kind, state: stateRu(state) }, 'Смена состояния');
    this.onTransition(ev);
  }

  async checkAll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let hostReachable = true;
      for (const s of this.store.list()) {
        const state = await queryService(s.name, this.host);
        if (state === 'UNREACHABLE') {
          // Сервер не отвечает: состояние служб неизвестно, тревожим одним сообщением о сервере
          hostReachable = false;
          break;
        }
        const key = s.name.toLowerCase();
        let t = this.tracked.get(key);
        if (!t) {
          t = newTracked();
          this.tracked.set(key, t);
        }
        this.emit(applyCheck(t, state, Date.now(), s), state);
      }
      if (this.host && this.store.list().length > 0) {
        const hostState: ServiceState = hostReachable ? 'RUNNING' : 'UNREACHABLE';
        const ev = applyCheck(this.hostTracked, hostState, Date.now(), { name: this.host, label: 'Сервер' });
        this.emit(ev && { ...ev, host: true }, hostState);
      }
      this.lastCheckAt = Date.now();
    } finally {
      this.running = false;
    }
  }

  /** Сервер подтверждённо недоступен */
  hostDown(): boolean {
    return this.hostTracked.down;
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
