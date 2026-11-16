import net from 'node:net';
import type { AppConfig, PortConfig } from '../config/index.js';
import { runSystemCommand } from '../utils/exec.js';
import type { Monitor, MonitorOutput, Observation } from './types.js';

export interface PortStatus {
  label: string;
  host: string;
  port: number;
  mode: 'listen' | 'connect';
  ok: boolean;
  latencyMs?: number;
  pids?: number[];
  error?: string;
}

export interface NetworkSnapshot {
  ports: PortStatus[];
}

/**
 * Разбор `netstat -ano -p TCP|TCPv6`. Состояние LISTENING локализовано, поэтому
 * слушающий сокет определяем по удалённому адресу 0.0.0.0:0 / [::]:0.
 * Возвращает: порт -> { адреса, PID }.
 */
export function parseNetstatListening(out: string): Map<number, { addrs: Set<string>; pids: Set<number> }> {
  const map = new Map<number, { addrs: Set<string>; pids: Set<number> }>();
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || !/^TCP/i.test(cols[0]!)) continue;
    const local = cols[1]!;
    const remote = cols[2]!;
    if (remote !== '0.0.0.0:0' && remote !== '[::]:0' && remote !== '*:*') continue;
    const idx = local.lastIndexOf(':');
    const port = Number(local.slice(idx + 1));
    const addr = local.slice(0, idx);
    const pid = Number(cols[cols.length - 1]);
    if (!Number.isInteger(port)) continue;
    const e = map.get(port) ?? { addrs: new Set<string>(), pids: new Set<number>() };
    e.addrs.add(addr);
    if (Number.isInteger(pid)) e.pids.add(pid);
    map.set(port, e);
  }
  return map;
}

function listenMatches(host: string, addrs: Set<string>): boolean {
  if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0' || host === '*') return addrs.size > 0;
  // Порт слушается на конкретном адресе либо на всех интерфейсах
  return addrs.has(host) || addrs.has('0.0.0.0') || addrs.has('[::]');
}

export function tcpProbe(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; latencyMs?: number; error?: string }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const sock = net.createConnection({ host, port });
    let done = false;
    const finish = (r: { ok: boolean; latencyMs?: number; error?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: `таймаут ${timeoutMs} мс` }), timeoutMs);
    sock.once('connect', () => finish({ ok: true, latencyMs: Date.now() - started }));
    sock.once('error', (e: NodeJS.ErrnoException) => finish({ ok: false, error: e.code ?? e.message }));
  });
}

export class NetworkMonitor implements Monitor<NetworkSnapshot> {
  readonly name = 'network' as const;
  readonly intervalSec: number;

  constructor(private readonly cfg: AppConfig) {
    this.intervalSec = cfg.intervals.networkSec;
  }

  enabled(): boolean {
    return this.cfg.ports.length > 0;
  }

  private async listening(): Promise<Map<number, { addrs: Set<string>; pids: Set<number> }>> {
    const v4 = await runSystemCommand('netstat', ['-ano', '-p', 'TCP'], 20_000);
    const v6 = await runSystemCommand('netstat', ['-ano', '-p', 'TCPv6'], 20_000);
    if (v4.exitCode !== 0) throw new Error(`netstat завершился с кодом ${v4.exitCode}`);
    return parseNetstatListening(`${v4.stdout}\n${v6.stdout}`);
  }

  async run(): Promise<MonitorOutput<NetworkSnapshot>> {
    const needListen = this.cfg.ports.some((p) => p.mode === 'listen');
    const table = needListen ? await this.listening() : new Map();
    const ports: PortStatus[] = [];
    const observations: Observation[] = [];
    const { failChecks, recoverChecks } = this.cfg.confirm;

    const probes = this.cfg.ports.map(async (p: PortConfig): Promise<PortStatus> => {
      if (p.mode === 'listen') {
        const e = table.get(p.port);
        const ok = !!e && listenMatches(p.host, e.addrs);
        return { label: p.label, host: p.host, port: p.port, mode: p.mode, ok, pids: e ? [...e.pids] : [], error: ok ? undefined : 'порт не прослушивается' };
      }
      const r = await tcpProbe(p.host, p.port, p.timeoutMs);
      return { label: p.label, host: p.host, port: p.port, mode: p.mode, ...r };
    });

    for (const s of await Promise.all(probes)) {
      ports.push(s);
      observations.push({
        key: `port:${s.mode}:${s.host}:${s.port}`,
        kind: 'port',
        level: s.ok ? 'OK' : 'CRITICAL',
        subject: ['Порт', `${s.label} (${s.host}:${s.port})`],
        alertTitle: 'PORT UNAVAILABLE',
        recoveredTitle: 'PORT RESTORED',
        event: s.mode === 'listen' ? 'порт не прослушивается' : `нет TCP-подключения (${s.error ?? 'ошибка'})`,
        status: 'DOWN',
        details: [],
        confirmFail: failChecks,
        confirmRecover: recoverChecks,
      });
    }
    return { snapshot: { ports }, observations, events: [] };
  }
}
