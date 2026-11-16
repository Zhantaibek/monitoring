import { test } from 'node:test';
import assert from 'node:assert/strict';
import { StateTracker } from '../core/state-tracker.js';
import { isWindowActive } from '../core/maintenance.js';
import { levelHigh, levelLow } from '../monitoring/system.monitor.js';
import { parseTasklistCsv } from '../monitoring/process.monitor.js';
import { parseScQuery } from '../monitoring/service.monitor.js';
import { parseNetstatListening } from '../monitoring/network.monitor.js';
import { parseEventsXml } from '../monitoring/eventlog.monitor.js';
import { formatTransition } from '../bot/notifications/formatter.js';
import { fmtDuration, setTimeZone } from '../utils/time.js';
import { ConfigSchema } from '../config/index.js';
import type { Level, Observation } from '../monitoring/types.js';

setTimeZone('Asia/Bishkek');

test('config: значения по умолчанию из ТЗ и валидация порогов', () => {
  const c = ConfigSchema.parse({});
  assert.deepEqual(c.thresholds.cpu, { warning: 85, critical: 95 });
  assert.deepEqual(c.thresholds.ram, { warning: 85, critical: 95 });
  assert.deepEqual(c.thresholds.diskFree, { warning: 15, critical: 5 });
  assert.equal(c.timezone, 'Asia/Bishkek');
  assert.equal(c.server.ip, '172.23.10.82');
  assert.equal(c.intervals.processSec, 15);
  assert.equal(c.eventLog.sources[0]?.log, 'System');
  assert.deepEqual(c.processes, []);
  // частичное переопределение сохраняет остальные значения
  assert.deepEqual(ConfigSchema.parse({ thresholds: { cpu: { warning: 70 } } }).thresholds.cpu, { warning: 70, critical: 95 });
  assert.equal(ConfigSchema.safeParse({ thresholds: { cpu: { warning: 96, critical: 95 } } }).success, false);
  assert.equal(ConfigSchema.safeParse({ processes: [{ label: 'x', image: 'C:\\path\\x.exe' }] }).success, false);
  assert.equal(ConfigSchema.safeParse({ timezone: 'Mars/Base' }).success, false);
});

function obs(level: Level, extra: Partial<Observation> = {}): Observation {
  return {
    key: 'process:test.exe',
    kind: 'process',
    level,
    subject: ['Процесс', 'Test (test.exe)'],
    alertTitle: 'QUIK PROCESS STOPPED',
    recoveredTitle: 'QUIK PROCESS RESTORED',
    event: 'процесс завершён',
    status: 'DOWN',
    details: [],
    confirmFail: 2,
    confirmRecover: 2,
    ...extra,
  };
}

test('tracker: одно уведомление на проблему, подтверждение N проверками', () => {
  const t = new StateTracker();
  assert.equal(t.observe(obs('OK'), 0), null);
  assert.equal(t.observe(obs('CRITICAL'), 1000), null); // 1-я неудача — не подтверждено
  const down = t.observe(obs('CRITICAL'), 2000);
  assert.ok(down);
  assert.equal(down.from, 'OK');
  assert.equal(down.to, 'CRITICAL');
  assert.equal(down.incidentStart, 1000);
  // повторы той же проблемы — без уведомлений
  for (let i = 3; i < 10; i++) assert.equal(t.observe(obs('CRITICAL'), i * 1000), null);
  assert.equal(t.observe(obs('OK'), 240_000), null);
  const up = t.observe(obs('OK'), 241_000);
  assert.ok(up);
  assert.equal(up.to, 'OK');
  assert.equal(up.at - up.incidentStart, 239_000);
});

test('tracker: кратковременный сбой (flapping) не порождает уведомлений', () => {
  const t = new StateTracker();
  for (let i = 0; i < 10; i++) {
    assert.equal(t.observe(obs(i % 2 ? 'CRITICAL' : 'OK'), i * 1000), null);
  }
});

test('tracker: эскалация WARNING → CRITICAL и восстановление из истории', () => {
  const t = new StateTracker();
  t.restore([{ key: 'sys:cpu', level: 'WARNING', since: 500 }]);
  const o = (l: Level) => obs(l, { key: 'sys:cpu', kind: 'cpu' });
  assert.equal(t.observe(o('WARNING'), 1000), null); // после рестарта — без повторного уведомления
  t.observe(o('CRITICAL'), 2000);
  const esc = t.observe(o('CRITICAL'), 3000);
  assert.equal(esc?.from, 'WARNING');
  assert.equal(esc?.incidentStart, 500);
});

test('пороги с гистерезисом', () => {
  assert.equal(levelHigh(80, 85, 95, 5, 'OK'), 'OK');
  assert.equal(levelHigh(86, 85, 95, 5, 'OK'), 'WARNING');
  assert.equal(levelHigh(96, 85, 95, 5, 'OK'), 'CRITICAL');
  assert.equal(levelHigh(82, 85, 95, 5, 'WARNING'), 'WARNING'); // ещё не ниже 80
  assert.equal(levelHigh(79, 85, 95, 5, 'WARNING'), 'OK');
  assert.equal(levelHigh(92, 85, 95, 5, 'CRITICAL'), 'CRITICAL');
  assert.equal(levelLow(20, 15, 5, 1, 'OK'), 'OK');
  assert.equal(levelLow(14, 15, 5, 1, 'OK'), 'WARNING');
  assert.equal(levelLow(4, 15, 5, 1, 'OK'), 'CRITICAL');
  assert.equal(levelLow(15.5, 15, 5, 1, 'WARNING'), 'WARNING');
});

test('tasklist CSV', () => {
  const out = '"System Idle Process","0","Services","0","8 K"\r\n"Info.exe","1234","Services","0","1 204 560 K"\r\n"info.exe","1240","Services","0","100 K"\r\n';
  const m = parseTasklistCsv(out);
  assert.equal(m.get('info.exe')?.length, 2);
  assert.equal(m.get('info.exe')?.[0]?.memKb, 1204560);
});

test('sc queryex: англ./рус. вывод, служба не найдена', () => {
  const en = 'SERVICE_NAME: Foo\r\n        TYPE               : 10  WIN32_OWN_PROCESS\r\n        STATE              : 4  RUNNING\r\n        PID                : 4321\r\n';
  assert.deepEqual(parseScQuery(en, 0), { state: 'RUNNING', pid: 4321 });
  const ru = 'Имя_службы: Foo\r\n        Тип                : 10  WIN32_OWN_PROCESS\r\n        Состояние          : 1  STOPPED\r\n        PID                : 0\r\n';
  assert.deepEqual(parseScQuery(ru, 0), { state: 'STOPPED', pid: undefined });
  assert.equal(parseScQuery('', 1060).state, 'NOT_FOUND');
});

test('netstat: определение LISTENING без зависимости от локализации', () => {
  const out = [
    '  TCP    0.0.0.0:7001           0.0.0.0:0              ПРОСЛУШИВАНИЕ   1500',
    '  TCP    10.0.0.5:7002          0.0.0.0:0              LISTENING       1501',
    '  TCP    10.0.0.5:7001          10.0.0.9:50000         ESTABLISHED     1500',
    '  TCP    [::]:7003              [::]:0                 LISTENING       1502',
  ].join('\r\n');
  const m = parseNetstatListening(out);
  assert.ok(m.get(7001)?.addrs.has('0.0.0.0'));
  assert.ok(m.get(7002)?.pids.has(1501));
  assert.ok(m.get(7003)?.addrs.has('[::]'));
  assert.equal(m.has(50000), false);
});

test('wevtutil XML: только метаданные', () => {
  const xml = `<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'><System><Provider Name='Microsoft-Windows-Kernel-Power' Guid='{x}'/><EventID>41</EventID><Level>1</Level><TimeCreated SystemTime='2026-11-13T08:00:00.000Z'/><EventRecordID>9001</EventRecordID></System><EventData><Data Name='BugcheckCode'>0</Data></EventData></Event>
<Event xmlns='x'><System><Provider Name='Application Error'/><EventID Qualifiers='0'>1000</EventID><Level>2</Level><EventRecordID>9002</EventRecordID></System><EventData><Data>info.exe</Data><Data>secret-ish</Data></EventData></Event>`;
  const ev = parseEventsXml(xml);
  assert.equal(ev.length, 2);
  assert.equal(ev[0]?.eventId, 41);
  assert.equal(ev[0]?.app, undefined);
  assert.equal(ev[1]?.app, 'info.exe');
});

test('окна обслуживания (Asia/Bishkek, UTC+6), включая переход через полночь', () => {
  const w = { label: 'night', days: ['mon' as const], start: '23:00', end: '01:00', suppress: ['process' as const] };
  // Пн 23:30 Бишкек = Пн 17:30 UTC
  assert.equal(isWindowActive(w, Date.parse('2026-11-16T17:30:00Z')), true);
  // Вт 00:30 Бишкек = Пн 18:30 UTC — продолжение окна понедельника
  assert.equal(isWindowActive(w, Date.parse('2026-11-16T18:30:00Z')), true);
  // Вт 01:30 Бишкек
  assert.equal(isWindowActive(w, Date.parse('2026-11-16T19:30:00Z')), false);
});

test('формат уведомлений соответствует ТЗ', () => {
  const t = new StateTracker();
  t.observe(obs('CRITICAL'), Date.parse('2026-11-13T08:00:00Z'));
  const down = t.observe(obs('CRITICAL'), Date.parse('2026-11-13T08:00:15Z'))!;
  const text = formatTransition(down, { name: 'QUIK Production', ip: '172.23.10.82' });
  assert.match(text, /^🔴 <b>CRITICAL: QUIK PROCESS STOPPED<\/b>/);
  assert.match(text, /IP: 172\.23\.10\.82/);
  assert.match(text, /Время: 13\.11\.2026 14:00:00/); // UTC+6
  assert.match(text, /Статус: DOWN/);
  assert.equal(fmtDuration(4 * 60_000), '4 минуты');
});
