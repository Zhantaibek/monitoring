import type { AppConfig } from '../config/index.js';
import type { Database } from '../database/db.js';
import { errMsg, type Logger } from '../logger/index.js';
import { worstLevel, type InfoEvent, type Level, type Monitor, type MonitorName, type Observation } from '../monitoring/types.js';
import { formatInfoEvent, formatStillDown, formatTransition, type ServerInfo } from '../bot/notifications/formatter.js';
import { activeWindowFor } from './maintenance.js';
import { StateTracker, type Transition } from './state-tracker.js';

export interface Snapshot<S = unknown> {
  data?: S;
  at?: number;
  error?: string;
  durationMs?: number;
}

export interface NotifierLike {
  enqueue(text: string): void;
}

/**
 * Monitoring Core: планирует проверки (без наложения запусков), подтверждает
 * состояния через StateTracker, сохраняет инциденты и отправляет уведомления
 * только при подтверждённой смене состояния.
 */
export class MonitoringCore {
  readonly tracker = new StateTracker();
  private snapshots = new Map<MonitorName, Snapshot>();
  private timers = new Map<MonitorName, NodeJS.Timeout>();
  private running = new Set<MonitorName>();
  private stopped = false;
  private suppressed = new Set<string>(); // ключи, уведомления по которым подавлены окном обслуживания
  private readonly startedAt = Date.now();
  private housekeepingTimer?: NodeJS.Timeout;
  private maintenanceTimer?: NodeJS.Timeout;
  lastCheckAt: number | null = null;

  constructor(
    private readonly cfg: AppConfig,
    private readonly monitors: Monitor[],
    private readonly db: Database,
    private readonly notifier: NotifierLike,
    private readonly log: Logger,
  ) {
    this.tracker.restore(db.loadStates());
  }

  get server(): ServerInfo {
    return this.cfg.server;
  }

  get appStartedAt(): number {
    return this.startedAt;
  }

  snapshot<S>(name: MonitorName): Snapshot<S> {
    return (this.snapshots.get(name) ?? {}) as Snapshot<S>;
  }

  isEnabled(name: MonitorName): boolean {
    return this.monitors.some((m) => m.name === name && m.enabled());
  }

  start(): void {
    let delay = 0;
    for (const m of this.monitors) {
      if (!m.enabled()) {
        this.log.warn({ monitor: m.name }, 'Монитор отключён: нечего проверять (пустая конфигурация)');
        continue;
      }
      this.schedule(m, delay);
      delay += 1500; // разносим первые запуски, чтобы не создавать пик нагрузки
    }

    // Обслуживание: проблемы, восстановленные из БД, но больше не наблюдаемые; очистка истории.
    const maxInterval = Math.max(...this.monitors.map((m) => m.intervalSec)) * 1000;
    setTimeout(() => this.closeStale(), maxInterval * 2 + 30_000).unref();
    this.housekeepingTimer = setInterval(() => this.housekeeping(), 6 * 3600_000);
    this.maintenanceTimer = setInterval(() => this.checkMaintenanceEnd(), 60_000);
    this.housekeeping();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.housekeepingTimer) clearInterval(this.housekeepingTimer);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
  }

  private schedule(m: Monitor, delayMs: number): void {
    if (this.stopped) return;
    const t = setTimeout(async () => {
      await this.runMonitor(m);
      this.schedule(m, m.intervalSec * 1000);
    }, delayMs);
    this.timers.set(m.name, t);
  }

  /** Один запуск монитора. Ошибка проверки — отдельное наблюдение check:<name>, а не «падение» объектов. */
  async runMonitor(m: Monitor): Promise<void> {
    if (this.running.has(m.name) || this.stopped) return;
    this.running.add(m.name);
    const started = Date.now();
    try {
      const out = await m.run({ currentLevel: (k) => this.tracker.level(k) });
      const now = Date.now();
      this.snapshots.set(m.name, { data: out.snapshot, at: now, durationMs: now - started });
      this.lastCheckAt = now;
      this.handle(this.selfObservation(m, 'OK'), now);
      for (const o of out.observations) this.handle(o, now);
      for (const ev of out.events) this.handleEvent(ev, now);
    } catch (err) {
      const msg = errMsg(err);
      const now = Date.now();
      this.log.error({ monitor: m.name, err: msg }, 'Ошибка проверки');
      const prev = this.snapshots.get(m.name) ?? {};
      this.snapshots.set(m.name, { ...prev, error: msg, at: now });
      this.handle(this.selfObservation(m, 'WARNING', msg), now);
    } finally {
      this.running.delete(m.name);
    }
  }

  private selfObservation(m: Monitor, level: Level, error?: string): Observation {
    return {
      key: `check:${m.name}`,
      kind: 'monitor',
      level,
      subject: ['Проверка', m.name],
      alertTitle: 'MONITORING CHECK FAILED',
      recoveredTitle: 'MONITORING CHECK RESTORED',
      event: error ? `ошибка выполнения проверки: ${error.slice(0, 200)}` : undefined,
      details: [],
      confirmFail: 3,
      confirmRecover: 1,
    };
  }

  private handle(o: Observation, now: number): void {
    const t = this.tracker.observe(o, now);
    if (!t) return;
    this.persist(t);

    const window = activeWindowFor(this.cfg.maintenanceWindows, o.kind, now);
    const message = formatTransition(t, this.server);
    const summary = `${t.from} → ${t.to}: ${o.subject[1]}`;

    if (window) {
      if (t.to === 'OK') this.suppressed.delete(t.key);
      else this.suppressed.add(t.key);
      this.db.addEvent({ key: t.key, type: 'transition', level: t.to, message: `${summary} [окно обслуживания: ${window.label}]`, notified: false });
      this.log.info({ key: t.key, from: t.from, to: t.to, window: window.label }, 'Переход в окне обслуживания — уведомление подавлено');
      return;
    }
    // Восстановление объекта, проблема по которому была подавлена окном — не сообщаем о «восстановлении» без сообщения о сбое
    if (t.to === 'OK' && this.suppressed.delete(t.key)) {
      this.db.addEvent({ key: t.key, type: 'transition', level: t.to, message: summary, notified: false });
      return;
    }
    this.db.addEvent({ key: t.key, type: 'transition', level: t.to, message: summary, notified: true });
    this.log.warn({ key: t.key, from: t.from, to: t.to }, 'Смена состояния');
    this.notifier.enqueue(message);
  }

  private persist(t: Transition): void {
    try {
      if (t.to === 'OK') {
        this.db.closeIncident(t.key, t.at);
        this.db.deleteState(t.key);
      } else {
        this.db.saveState({ key: t.key, level: t.to, since: t.incidentStart });
        if (t.from === 'OK') {
          this.db.openIncident({ key: t.key, kind: t.obs.kind, title: t.obs.alertTitle, subject: t.obs.subject[1], severity: t.to, startedAt: t.incidentStart });
        } else {
          this.db.updateIncidentSeverity(t.key, t.to);
        }
      }
    } catch (err) {
      this.log.error({ err: errMsg(err) }, 'Ошибка записи в БД');
    }
  }

  private handleEvent(ev: InfoEvent, now: number): void {
    const window = ev.kind !== 'eventlog' ? activeWindowFor(this.cfg.maintenanceWindows, ev.kind, now) : undefined;
    const message = `${ev.title}: ${ev.details.map(([k, v]) => `${k}=${v}`).join('; ')}`;
    this.db.addEvent({ key: ev.key, type: 'event', level: ev.level, message, notified: !window });
    if (window) return;
    this.notifier.enqueue(formatInfoEvent(ev, this.server, now));
  }

  private housekeeping(): void {
    try {
      this.db.cleanup(this.cfg.history.retentionDays);
    } catch (err) {
      this.log.error({ err: errMsg(err) }, 'Ошибка очистки БД');
    }
  }

  /** После окончания окна обслуживания сообщить о проблемах, которые всё ещё есть. */
  checkMaintenanceEnd(now = Date.now()): void {
    for (const key of [...this.suppressed]) {
      const obs = this.tracker.lastObservation(key);
      if (!obs) continue;
      if (activeWindowFor(this.cfg.maintenanceWindows, obs.kind, now)) continue;
      this.suppressed.delete(key);
      const level = this.tracker.level(key);
      if (level === 'OK') continue;
      this.notifier.enqueue(formatStillDown(obs.alertTitle, obs.subject, level, this.tracker.since(key) ?? now, this.server, now));
    }
  }

  private closeStale(): void {
    for (const s of this.tracker.takeStale(this.startedAt)) {
      this.log.info({ key: s.key }, 'Объект больше не наблюдается (удалён из конфигурации) — инцидент закрыт');
      this.db.closeIncident(s.key, Date.now());
      this.db.deleteState(s.key);
    }
  }

  /** Сводный уровень по всем объектам (для /status). */
  overall(): Level {
    return worstLevel(this.tracker.problems().map((p) => p.level));
  }
}
