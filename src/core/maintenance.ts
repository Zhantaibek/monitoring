import type { MaintenanceWindow } from '../config/index.js';
import type { Kind } from '../monitoring/types.js';
import { localClock, prevWeekday } from '../utils/time.js';

function toMin(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/** Окно активно? Окно через полночь (22:00–02:00) относится к дню начала. */
export function isWindowActive(w: MaintenanceWindow, now: number): boolean {
  const { weekday, minutes } = localClock(now);
  const s = toMin(w.start);
  const e = toMin(w.end);
  if (s === e) return false;
  if (s < e) return w.days.includes(weekday) && minutes >= s && minutes < e;
  if (minutes >= s) return w.days.includes(weekday);
  if (minutes < e) return w.days.includes(prevWeekday(weekday));
  return false;
}

/** Возвращает активное окно, подавляющее уведомления для данного типа объекта. */
export function activeWindowFor(windows: MaintenanceWindow[], kind: Kind, now: number): MaintenanceWindow | undefined {
  return windows.find((w) => (w.suppress as string[]).includes(kind) && isWindowActive(w, now));
}
