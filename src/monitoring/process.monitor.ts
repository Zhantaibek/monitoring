import type { AppConfig } from '../config/index.js';
import { runSystemCommand } from '../utils/exec.js';
import type { InfoEvent, Monitor, MonitorOutput, Observation } from './types.js';

export interface ProcInstance {
  pid: number;
  memKb: number;
}

export interface ProcessStatus {
  label: string;
  image: string;
  minInstances: number;
  instances: ProcInstance[];
  running: boolean;
}

export interface ProcessSnapshot {
  processes: ProcessStatus[];
}

/** Разбор `tasklist /FO CSV /NH`: "image","pid","session","session#","mem" */
export function parseTasklistCsv(out: string): Map<string, ProcInstance[]> {
  const map = new Map<string, ProcInstance[]>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^"([^"]*)","(\d+)","[^"]*","[^"]*","([^"]*)"/.exec(line.trim());
    if (!m) continue;
    const image = m[1]!.toLowerCase();
    const pid = Number(m[2]);
    const memKb = Number((m[3] ?? '').replace(/\D/g, '')) || 0;
    const list = map.get(image) ?? [];
    list.push({ pid, memKb });
    map.set(image, list);
  }
  return map;
}

export class ProcessMonitor implements Monitor<ProcessSnapshot> {
  readonly name = 'process' as const;
  readonly intervalSec: number;
  private lastPids = new Map<string, Set<number>>();

  constructor(private readonly cfg: AppConfig) {
    this.intervalSec = cfg.intervals.processSec;
  }

  enabled(): boolean {
    return this.cfg.processes.length > 0;
  }

  async run(): Promise<MonitorOutput<ProcessSnapshot>> {
    const res = await runSystemCommand('tasklist', ['/FO', 'CSV', '/NH'], 20_000);
    if (res.exitCode !== 0) throw new Error(`tasklist завершился с кодом ${res.exitCode}`);
    const table = parseTasklistCsv(res.stdout);
    if (table.size === 0) throw new Error('tasklist вернул пустой список процессов');

    const processes: ProcessStatus[] = [];
    const observations: Observation[] = [];
    const events: InfoEvent[] = [];
    const { failChecks, recoverChecks } = this.cfg.confirm;

    for (const p of this.cfg.processes) {
      const image = p.image.toLowerCase();
      const instances = table.get(image) ?? [];
      const running = instances.length >= p.minInstances;
      processes.push({ label: p.label, image: p.image, minInstances: p.minInstances, instances, running });

      const subject = `${p.label} (${p.image})`;
      const countLine: [string, string][] =
        p.minInstances > 1 ? [['Экземпляров', `${instances.length} из ${p.minInstances}`]] : [];

      observations.push({
        key: `process:${image}`,
        kind: 'process',
        level: running ? 'OK' : 'CRITICAL',
        subject: ['Процесс', subject],
        alertTitle: 'QUIK PROCESS STOPPED',
        recoveredTitle: 'QUIK PROCESS RESTORED',
        event: instances.length === 0 ? 'процесс завершён' : 'недостаточно экземпляров процесса',
        status: 'DOWN',
        details: countLine,
        confirmFail: failChecks,
        confirmRecover: recoverChecks,
      });

      // Перезапуск между двумя проверками: процесс есть, но ни одного прежнего PID не осталось.
      const now = new Set(instances.map((i) => i.pid));
      const prev = this.lastPids.get(image);
      if (prev && prev.size > 0 && now.size > 0 && ![...prev].some((pid) => now.has(pid))) {
        events.push({
          key: `process:${image}`,
          kind: 'process',
          level: 'WARNING',
          title: 'QUIK PROCESS RESTARTED',
          details: [
            ['Процесс', subject],
            ['Событие', 'процесс перезапущен между проверками'],
            ['PID', `${[...prev].join(', ')} → ${[...now].join(', ')}`],
          ],
        });
      }
      this.lastPids.set(image, now);
    }

    return { snapshot: { processes }, observations, events };
  }
}
