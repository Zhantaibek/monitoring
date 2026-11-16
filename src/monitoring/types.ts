export type Level = 'OK' | 'WARNING' | 'CRITICAL';
export type Kind = 'process' | 'service' | 'port' | 'cpu' | 'ram' | 'disk' | 'monitor';
export type MonitorName = 'system' | 'process' | 'service' | 'network' | 'eventlog';

export const LEVEL_RANK: Record<Level, number> = { OK: 0, WARNING: 1, CRITICAL: 2 };

export function worstLevel(levels: Iterable<Level>): Level {
  let w: Level = 'OK';
  for (const l of levels) if (LEVEL_RANK[l] > LEVEL_RANK[w]) w = l;
  return w;
}

/** Строка сообщения: [метка, значение] */
export type Line = [string, string];

/**
 * Результат проверки одного объекта. Ядро превращает последовательность наблюдений
 * в подтверждённые переходы состояний (и только они порождают уведомления).
 */
export interface Observation {
  key: string; // уникальный ключ объекта: process:foo.exe, sys:cpu, disk:C:
  kind: Kind;
  level: Level;
  subject: Line; // ['Процесс', 'QUIK Server (foo.exe)']
  alertTitle: string; // 'QUIK PROCESS STOPPED'
  recoveredTitle: string; // 'QUIK PROCESS RESTORED'
  event?: string; // 'процесс завершён'
  status?: string; // 'DOWN'
  details: Line[]; // доп. строки (CPU, RAM, ...)
  confirmFail: number; // сколько подряд проверок нужно для подтверждения проблемы
  confirmRecover: number; // ... для подтверждения восстановления
}

/** Разовое событие (не состояние): ошибки в журнале, перезапуск процесса между проверками. */
export interface InfoEvent {
  key: string;
  kind: Kind | 'eventlog';
  level: Level;
  title: string;
  details: Line[];
}

export interface MonitorOutput<S = unknown> {
  snapshot: S;
  observations: Observation[];
  events: InfoEvent[];
}

export interface MonitorContext {
  /** Текущий подтверждённый уровень объекта (для гистерезиса). */
  currentLevel(key: string): Level;
}

export interface Monitor<S = unknown> {
  readonly name: MonitorName;
  readonly intervalSec: number;
  /** false = нечего проверять (пустая конфигурация) */
  enabled(): boolean;
  run(ctx: MonitorContext): Promise<MonitorOutput<S>>;
}
