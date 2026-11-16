import type { AppConfig, EventSourceConfig } from '../config/index.js';
import { runSystemCommand } from '../utils/exec.js';
import type { InfoEvent, Level, Line, Monitor, MonitorOutput } from './types.js';

/**
 * Чтение системных журналов Windows (только wevtutil qe).
 * В уведомления попадают ТОЛЬКО источник, код события, уровень и количество —
 * текст сообщений журнала не читается и не пересылается.
 */

export interface ParsedEvent {
  recordId: number;
  provider: string;
  eventId: number;
  level: number;
  time: string;
  app?: string; // имя приложения для Application Error (1000)
}

export interface EventLogSnapshot {
  sources: { log: string; lastRecordId: number; newEvents: number; checkedAt: number }[];
}

export interface KeyValueStore {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
}

const SAFE = /[^\w.\- ]/g;

export function parseEventsXml(xml: string): ParsedEvent[] {
  const result: ParsedEvent[] = [];
  const re = /<Event[\s>][\s\S]*?<\/Event>/g;
  for (const m of xml.matchAll(re)) {
    const ev = m[0];
    const recordId = Number(/<EventRecordID>(\d+)</.exec(ev)?.[1]);
    if (!Number.isFinite(recordId)) continue;
    const provider = (/<Provider\s+Name=['"]([^'"]+)['"]/.exec(ev)?.[1] ?? 'unknown').replace(SAFE, '').slice(0, 80);
    const eventId = Number(/<EventID[^>]*>(\d+)</.exec(ev)?.[1] ?? 0);
    const level = Number(/<Level>(\d+)</.exec(ev)?.[1] ?? 0);
    const time = /<TimeCreated\s+SystemTime=['"]([^'"]+)['"]/.exec(ev)?.[1] ?? '';
    let app: string | undefined;
    if (provider === 'Application Error' || provider === 'Windows Error Reporting') {
      const d = /<Data(?:\s+Name=['"][^'"]*['"])?>([^<]{1,128})<\/Data>/.exec(ev)?.[1];
      if (d) app = d.replace(SAFE, '').slice(0, 64);
    }
    result.push({ recordId, provider, eventId, level, time, app });
  }
  return result;
}

const LEVEL_NAMES: Record<number, string> = { 1: 'Critical', 2: 'Error', 3: 'Warning' };

export class EventLogMonitor implements Monitor<EventLogSnapshot> {
  readonly name = 'eventlog' as const;
  readonly intervalSec: number;
  private snapshot: EventLogSnapshot = { sources: [] };

  constructor(
    private readonly cfg: AppConfig,
    private readonly kv: KeyValueStore,
  ) {
    this.intervalSec = cfg.intervals.eventLogSec;
  }

  enabled(): boolean {
    return this.cfg.eventLog.enabled && this.cfg.eventLog.sources.length > 0;
  }

  private async latestRecordId(log: string): Promise<number> {
    const r = await runSystemCommand('wevtutil', ['qe', log, '/c:1', '/rd:true', '/f:xml'], 20_000);
    if (r.exitCode !== 0) throw new Error(`wevtutil ${log}: код ${r.exitCode}`);
    return parseEventsXml(r.stdout)[0]?.recordId ?? 0;
  }

  private async checkSource(src: EventSourceConfig): Promise<{ events: ParsedEvent[]; last: number }> {
    const kvKey = `eventlog:last:${src.log}`;
    const latest = await this.latestRecordId(src.log);
    const storedRaw = this.kv.get(kvKey);
    const stored = storedRaw ? Number(storedRaw) : NaN;

    // Первый запуск или журнал очищен — устанавливаем базовую точку без уведомлений.
    if (!Number.isFinite(stored) || latest < stored) {
      this.kv.set(kvKey, String(latest));
      return { events: [], last: latest };
    }
    if (latest === stored) return { events: [], last: stored };

    const levels = src.levels.map((l) => `Level=${l}`).join(' or ');
    const query = `*[System[(${levels}) and (EventRecordID > ${stored})]]`;
    const r = await runSystemCommand('wevtutil', ['qe', src.log, `/q:${query}`, '/c:200', '/rd:true', '/f:xml'], 30_000);
    if (r.exitCode !== 0) throw new Error(`wevtutil ${src.log}: код ${r.exitCode}`);

    const events = parseEventsXml(r.stdout).filter(
      (e) =>
        !src.ignoreEventIds.includes(e.eventId) &&
        (src.providers.length === 0 || src.providers.some((p) => p.toLowerCase() === e.provider.toLowerCase())),
    );
    this.kv.set(kvKey, String(latest));
    return { events, last: latest };
  }

  async run(): Promise<MonitorOutput<EventLogSnapshot>> {
    const out: InfoEvent[] = [];
    const sources: EventLogSnapshot['sources'] = [];
    const max = this.cfg.eventLog.maxItemsInAlert;

    for (const src of this.cfg.eventLog.sources) {
      const { events, last } = await this.checkSource(src);
      sources.push({ log: src.log, lastRecordId: last, newEvents: events.length, checkedAt: Date.now() });
      if (events.length === 0) continue;

      // Группировка: источник + код + приложение
      const groups = new Map<string, { count: number; level: number }>();
      for (const e of events) {
        const k = `${e.provider} (ID ${e.eventId})${e.app ? ` — ${e.app}` : ''}`;
        const g = groups.get(k) ?? { count: 0, level: e.level };
        g.count++;
        g.level = Math.min(g.level || 9, e.level || 9);
        groups.set(k, g);
      }
      const sorted = [...groups.entries()].sort((a, b) => b[1].count - a[1].count);
      const level: Level = events.some((e) => e.level === 1) ? 'CRITICAL' : 'WARNING';
      const details: Line[] = [
        ['Журнал', src.log],
        ['Новых событий', String(events.length)],
        ...sorted.slice(0, max).map<Line>(([k, g]) => [`${LEVEL_NAMES[g.level] ?? 'Event'}`, `${k} ×${g.count}`]),
      ];
      if (sorted.length > max) details.push(['…', `ещё ${sorted.length - max} типов`]);
      out.push({ key: `eventlog:${src.log}`, kind: 'eventlog', level, title: `${src.log.toUpperCase()} LOG ERRORS`, details });
    }

    this.snapshot = { sources };
    return { snapshot: this.snapshot, observations: [], events: out };
  }
}
