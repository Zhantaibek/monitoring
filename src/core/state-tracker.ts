import { LEVEL_RANK, type Level, type Observation } from '../monitoring/types.js';
import type { PersistedState } from '../database/db.js';

export interface Transition {
  key: string;
  from: Level;
  to: Level;
  obs: Observation;
  /** Начало инцидента (первое неуспешное наблюдение). */
  incidentStart: number;
  /** Время первого наблюдения нового состояния. */
  at: number;
}

interface Entry {
  level: Level;
  since: number;
  streak: number;
  streakDir: number; // +1 ухудшение, -1 улучшение
  streakSince: number;
  lastSeen: number;
  lastObs?: Observation;
}

/**
 * Подтверждение состояний (anti-flapping).
 * Переход происходит только после N подряд наблюдений в одном направлении
 * относительно подтверждённого уровня. Повторные наблюдения того же уровня
 * ничего не порождают — поэтому одна проблема = одно уведомление.
 */
export class StateTracker {
  private entries = new Map<string, Entry>();

  restore(states: PersistedState[]): void {
    for (const s of states) {
      this.entries.set(s.key, { level: s.level, since: s.since, streak: 0, streakDir: 0, streakSince: 0, lastSeen: 0 });
    }
  }

  level(key: string): Level {
    return this.entries.get(key)?.level ?? 'OK';
  }

  since(key: string): number | undefined {
    return this.entries.get(key)?.since;
  }

  lastObservation(key: string): Observation | undefined {
    return this.entries.get(key)?.lastObs;
  }

  /** Все объекты с подтверждённой проблемой. */
  problems(): { key: string; level: Level; since: number; obs?: Observation }[] {
    return [...this.entries.entries()]
      .filter(([, e]) => e.level !== 'OK')
      .map(([key, e]) => ({ key, level: e.level, since: e.since, obs: e.lastObs }));
  }

  observe(obs: Observation, now: number): Transition | null {
    let e = this.entries.get(obs.key);
    if (!e) {
      e = { level: 'OK', since: now, streak: 0, streakDir: 0, streakSince: 0, lastSeen: now };
      this.entries.set(obs.key, e);
    }
    e.lastSeen = now;
    e.lastObs = obs;

    const dir = Math.sign(LEVEL_RANK[obs.level] - LEVEL_RANK[e.level]);
    if (dir === 0) {
      e.streak = 0;
      e.streakDir = 0;
      return null;
    }
    if (dir !== e.streakDir) {
      e.streak = 0;
      e.streakDir = dir;
      e.streakSince = now;
    }
    e.streak++;

    const need = dir > 0 ? obs.confirmFail : obs.confirmRecover;
    if (e.streak < need) return null;

    const from = e.level;
    const at = e.streakSince;
    const incidentStart = from === 'OK' ? at : e.since;
    e.level = obs.level;
    if (from === 'OK' || obs.level === 'OK') e.since = at;
    e.streak = 0;
    e.streakDir = 0;
    return { key: obs.key, from, to: obs.level, obs, incidentStart, at };
  }

  /** Восстановленные из БД проблемы, которые больше не наблюдаются (объект удалён из конфигурации). */
  takeStale(seenAfter: number): { key: string; level: Level }[] {
    const stale: { key: string; level: Level }[] = [];
    for (const [key, e] of this.entries) {
      if (e.lastSeen < seenAfter) {
        if (e.level !== 'OK') stale.push({ key, level: e.level });
        this.entries.delete(key);
      }
    }
    return stale;
  }
}
