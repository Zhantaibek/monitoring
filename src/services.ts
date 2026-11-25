import fs from 'node:fs';
import path from 'node:path';
import { runSc } from './exec.js';

export type ServiceState =
  | 'RUNNING'
  | 'STOPPED'
  | 'START_PENDING'
  | 'STOP_PENDING'
  | 'CONTINUE_PENDING'
  | 'PAUSE_PENDING'
  | 'PAUSED'
  | 'NOT_FOUND'
  | 'ACCESS_DENIED'
  | 'UNKNOWN';

const STATE_RU: Record<ServiceState, string> = {
  RUNNING: 'работает',
  STOPPED: 'остановлена',
  START_PENDING: 'запускается',
  STOP_PENDING: 'останавливается',
  CONTINUE_PENDING: 'возобновляется',
  PAUSE_PENDING: 'приостанавливается',
  PAUSED: 'приостановлена',
  NOT_FOUND: 'не найдена',
  ACCESS_DENIED: 'нет доступа',
  UNKNOWN: 'неизвестно',
};

export function stateRu(s: ServiceState): string {
  return STATE_RU[s];
}

/** Короткое имя службы (Name, не отображаемое имя): без пробелов и спецсимволов. */
export function isValidServiceName(name: string): boolean {
  return /^[A-Za-z0-9_.$-]{1,256}$/.test(name);
}

/**
 * Разбор `sc queryex <name>`. Подписи полей локализованы, поэтому ищем по значению:
 * "STATE : 4  RUNNING" / "СОСТОЯНИЕ : 4 RUNNING".
 */
export function parseScQuery(out: string, exitCode: number): ServiceState {
  if (exitCode === 1060) return 'NOT_FOUND';
  if (exitCode === 5) return 'ACCESS_DENIED';
  const m = /:\s*\d+\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/.exec(out);
  return m ? (m[1] as ServiceState) : 'UNKNOWN';
}

export async function queryService(name: string): Promise<ServiceState> {
  const res = await runSc(['queryex', name], 10_000);
  return parseScQuery(res.stdout, res.exitCode);
}

export interface InstalledService {
  name: string;
  displayName: string;
}

/**
 * Разбор `sc query type= service state= all`. Подписи полей локализованы,
 * поэтому берём значения по порядку: 1-я строка блока — имя, 2-я — отображаемое имя.
 */
export function parseScList(out: string): InstalledService[] {
  const result: InstalledService[] = [];
  for (const block of out.split(/\r?\n\s*\r?\n/)) {
    const values = block
      .split(/\r?\n/)
      .map((l) => /^[^\s:][^:]*:\s*(.+)$/.exec(l.trim())?.[1]?.trim())
      .filter((v): v is string => Boolean(v));
    const [name, displayName] = values;
    if (name && displayName && isValidServiceName(name)) result.push({ name, displayName });
  }
  return result;
}

/** Поиск установленных служб по части имени или отображаемого имени. */
export async function findServices(text: string): Promise<InstalledService[]> {
  const res = await runSc(['query', 'type=', 'service', 'state=', 'all'], 20_000);
  const q = text.toLowerCase();
  return parseScList(res.stdout).filter((s) => s.name.toLowerCase().includes(q) || s.displayName.toLowerCase().includes(q));
}

export interface WatchedService {
  name: string;
  label: string;
}

/** Список отслеживаемых служб. Хранится в data/services.json, меняется командами бота. */
export class ServiceStore {
  private items: WatchedService[];

  constructor(
    private readonly file: string,
    seedConfigPath?: string,
  ) {
    if (fs.existsSync(file)) {
      this.items = ServiceStore.read(file);
    } else {
      this.items = seedConfigPath ? ServiceStore.readSeed(seedConfigPath) : [];
      this.save();
    }
  }

  private static read(file: string): WatchedService[] {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as unknown;
    if (!Array.isArray(raw)) throw new Error(`${file}: ожидается массив служб`);
    return raw
      .filter((s): s is WatchedService => typeof s?.name === 'string' && isValidServiceName(s.name))
      .map((s) => ({ name: s.name, label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : s.name }));
  }

  /** Перенос служб из старого config/config.json при первом запуске. */
  private static readSeed(seedPath: string): WatchedService[] {
    try {
      const cfg = JSON.parse(fs.readFileSync(seedPath, 'utf8').replace(/^﻿/, '')) as { services?: unknown };
      if (!Array.isArray(cfg.services)) return [];
      return cfg.services
        .filter((s): s is WatchedService => typeof s?.name === 'string' && isValidServiceName(s.name))
        .map((s) => ({ name: s.name, label: typeof s.label === 'string' && s.label.trim() ? s.label.trim() : s.name }));
    } catch {
      return [];
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list(): WatchedService[] {
    return [...this.items];
  }

  get(name: string): WatchedService | undefined {
    return this.items.find((s) => s.name.toLowerCase() === name.toLowerCase());
  }

  /** false — служба уже в списке. */
  add(s: WatchedService): boolean {
    if (this.get(s.name)) return false;
    this.items.push(s);
    this.save();
    return true;
  }

  remove(name: string): WatchedService | undefined {
    const found = this.get(name);
    if (!found) return undefined;
    this.items = this.items.filter((s) => s !== found);
    this.save();
    return found;
  }
}
