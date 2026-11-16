import os from 'node:os';
import fs from 'node:fs/promises';
import type { AppConfig } from '../config/index.js';
import type { Level, Line, Monitor, MonitorContext, MonitorOutput, Observation } from './types.js';

export interface DiskInfo {
  drive: string;
  totalBytes: number;
  freeBytes: number;
  freePercent: number;
  level: Level;
  error?: string;
}

export interface SystemSnapshot {
  cpuPercent: number;
  ramTotalBytes: number;
  ramUsedBytes: number;
  ramPercent: number;
  disks: DiskInfo[];
  uptimeSec: number;
  bootTime: number;
  osVersion: string;
  osRelease: string;
  hostname: string;
  cpuCount: number;
  cpuLevel: Level;
  ramLevel: Level;
}

/** Уровень для метрики «чем больше, тем хуже» с гистерезисом при восстановлении. */
export function levelHigh(value: number, warn: number, crit: number, hyst: number, current: Level): Level {
  if (value > crit || (current === 'CRITICAL' && value > crit - hyst)) return 'CRITICAL';
  if (value > warn || (current !== 'OK' && value > warn - hyst)) return 'WARNING';
  return 'OK';
}

/** Уровень для метрики «чем меньше, тем хуже» (свободное место). */
export function levelLow(value: number, warn: number, crit: number, hyst: number, current: Level): Level {
  if (value < crit || (current === 'CRITICAL' && value < crit + hyst)) return 'CRITICAL';
  if (value < warn || (current !== 'OK' && value < warn + hyst)) return 'WARNING';
  return 'OK';
}

function cpuTimes(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    const t = c.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what}: таймаут ${ms} мс`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const GB = 1024 ** 3;
export const fmtGb = (b: number) => `${(b / GB).toFixed(1)} ГБ`;

export class SystemMonitor implements Monitor<SystemSnapshot> {
  readonly name = 'system' as const;
  readonly intervalSec: number;
  private prev: { idle: number; total: number } | null = null;

  constructor(private readonly cfg: AppConfig) {
    this.intervalSec = cfg.intervals.systemSec;
  }

  enabled(): boolean {
    return true;
  }

  /** Средняя загрузка CPU с прошлого замера (на первом замере — за 1 секунду). */
  private async cpuPercent(): Promise<number> {
    if (!this.prev) {
      this.prev = cpuTimes();
      await new Promise((r) => setTimeout(r, 1000));
    }
    const cur = cpuTimes();
    const dTotal = cur.total - this.prev.total;
    const dIdle = cur.idle - this.prev.idle;
    this.prev = cur;
    if (dTotal <= 0) return 0;
    return Math.min(100, Math.max(0, (1 - dIdle / dTotal) * 100));
  }

  async run(ctx: MonitorContext): Promise<MonitorOutput<SystemSnapshot>> {
    const t = this.cfg.thresholds;
    const confirm = this.cfg.confirm.resourceChecks;
    const recover = this.cfg.confirm.recoverChecks;

    const cpu = await this.cpuPercent();
    const total = os.totalmem();
    const used = total - os.freemem(); // freemem на Windows = доступная физическая память
    const ramPct = total > 0 ? (used / total) * 100 : 0;

    const cpuLevel = levelHigh(cpu, t.cpu.warning, t.cpu.critical, t.hysteresis, ctx.currentLevel('sys:cpu'));
    const ramLevel = levelHigh(ramPct, t.ram.warning, t.ram.critical, t.hysteresis, ctx.currentLevel('sys:ram'));

    const disks: DiskInfo[] = [];
    for (const raw of this.cfg.disks) {
      const drive = raw.endsWith('\\') ? raw : `${raw}\\`;
      const key = `disk:${drive.slice(0, 2).toUpperCase()}`;
      try {
        const s = await withTimeout(fs.statfs(drive), 5000, `statfs ${drive}`);
        const totalB = Number(s.blocks) * Number(s.bsize);
        const freeB = Number(s.bavail) * Number(s.bsize);
        const freePct = totalB > 0 ? (freeB / totalB) * 100 : 0;
        const level = levelLow(freePct, t.diskFree.warning, t.diskFree.critical, t.diskHysteresis, ctx.currentLevel(key));
        disks.push({ drive: drive.slice(0, 2).toUpperCase(), totalBytes: totalB, freeBytes: freeB, freePercent: freePct, level });
      } catch (err) {
        disks.push({ drive: drive.slice(0, 2).toUpperCase(), totalBytes: 0, freeBytes: 0, freePercent: 0, level: 'CRITICAL', error: (err as Error).message });
      }
    }

    const uptimeSec = os.uptime();
    const snapshot: SystemSnapshot = {
      cpuPercent: cpu,
      ramTotalBytes: total,
      ramUsedBytes: used,
      ramPercent: ramPct,
      disks,
      uptimeSec,
      bootTime: Date.now() - uptimeSec * 1000,
      osVersion: os.version(),
      osRelease: os.release(),
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
      cpuLevel,
      ramLevel,
    };

    const resLines: Line[] = [
      ['CPU', `${cpu.toFixed(0)}%`],
      ['RAM', `${ramPct.toFixed(0)}% (${fmtGb(used)} из ${fmtGb(total)})`],
    ];

    const observations: Observation[] = [
      {
        key: 'sys:cpu',
        kind: 'cpu',
        level: cpuLevel,
        subject: ['Ресурс', 'CPU'],
        alertTitle: 'HIGH CPU USAGE',
        recoveredTitle: 'CPU USAGE NORMAL',
        details: resLines,
        confirmFail: confirm,
        confirmRecover: recover,
      },
      {
        key: 'sys:ram',
        kind: 'ram',
        level: ramLevel,
        subject: ['Ресурс', 'RAM'],
        alertTitle: 'HIGH MEMORY USAGE',
        recoveredTitle: 'MEMORY USAGE NORMAL',
        details: resLines,
        confirmFail: confirm,
        confirmRecover: recover,
      },
      ...disks.map<Observation>((d) => ({
        key: `disk:${d.drive}`,
        kind: 'disk',
        level: d.level,
        subject: ['Диск', d.drive],
        alertTitle: d.error ? 'DISK CHECK FAILED' : 'LOW DISK SPACE',
        recoveredTitle: 'DISK SPACE OK',
        details: d.error
          ? [['Ошибка', d.error]]
          : [
              ['Свободно', `${d.freePercent.toFixed(1)}% (${fmtGb(d.freeBytes)} из ${fmtGb(d.totalBytes)})`],
            ],
        confirmFail: confirm,
        confirmRecover: recover,
      })),
    ];

    return { snapshot, observations, events: [] };
  }
}
