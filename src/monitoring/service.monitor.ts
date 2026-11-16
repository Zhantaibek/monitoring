import type { AppConfig } from '../config/index.js';
import { runSystemCommand } from '../utils/exec.js';
import type { Monitor, MonitorOutput, Observation } from './types.js';

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

export interface ServiceStatus {
  label: string;
  name: string;
  state: ServiceState;
  pid?: number;
}

export interface ServiceSnapshot {
  services: ServiceStatus[];
}

const STATE_NAMES_RU: Record<ServiceState, string> = {
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

export function serviceStateRu(s: ServiceState): string {
  return STATE_NAMES_RU[s];
}

/**
 * Разбор `sc queryex <name>`. Подписи полей локализованы, поэтому ищем по значению:
 * "STATE : 4  RUNNING" / "СОСТОЯНИЕ : 4 RUNNING" и "PID : 1234".
 */
export function parseScQuery(out: string, exitCode: number): { state: ServiceState; pid?: number } {
  if (exitCode === 1060) return { state: 'NOT_FOUND' };
  if (exitCode === 5) return { state: 'ACCESS_DENIED' };
  const m = /:\s*\d+\s+(STOPPED|START_PENDING|STOP_PENDING|RUNNING|CONTINUE_PENDING|PAUSE_PENDING|PAUSED)\b/.exec(out);
  if (!m) return { state: 'UNKNOWN' };
  const pidMatch = /^\s*PID\s*:\s*(\d+)/m.exec(out);
  const pid = pidMatch ? Number(pidMatch[1]) : undefined;
  return { state: m[1] as ServiceState, pid: pid && pid > 0 ? pid : undefined };
}

export class ServiceMonitor implements Monitor<ServiceSnapshot> {
  readonly name = 'service' as const;
  readonly intervalSec: number;

  constructor(private readonly cfg: AppConfig) {
    this.intervalSec = cfg.intervals.serviceSec;
  }

  enabled(): boolean {
    return this.cfg.services.length > 0;
  }

  async run(): Promise<MonitorOutput<ServiceSnapshot>> {
    const services: ServiceStatus[] = [];
    const observations: Observation[] = [];
    const { failChecks, recoverChecks } = this.cfg.confirm;

    for (const s of this.cfg.services) {
      const res = await runSystemCommand('sc', ['queryex', s.name], 10_000);
      const parsed = parseScQuery(res.stdout, res.exitCode);
      services.push({ label: s.label, name: s.name, ...parsed });

      // START_PENDING/STOP_PENDING кратковременны — считаем проблемой только если не RUNNING после подтверждения
      const ok = parsed.state === 'RUNNING';
      observations.push({
        key: `service:${s.name.toLowerCase()}`,
        kind: 'service',
        level: ok ? 'OK' : 'CRITICAL',
        subject: ['Служба', `${s.label} (${s.name})`],
        alertTitle: 'SERVICE STOPPED',
        recoveredTitle: 'SERVICE RESTORED',
        event: `состояние службы: ${serviceStateRu(parsed.state)}`,
        status: 'DOWN',
        details: [],
        confirmFail: failChecks,
        confirmRecover: recoverChecks,
      });
    }
    return { snapshot: { services }, observations, events: [] };
  }
}
