import os from 'node:os';
import type { MonitoringCore } from '../../core/monitoring-core.js';
import type { Database } from '../../database/db.js';
import type { SystemSnapshot } from '../../monitoring/system.monitor.js';
import { fmtGb } from '../../monitoring/system.monitor.js';
import type { ProcessSnapshot } from '../../monitoring/process.monitor.js';
import type { ServiceSnapshot } from '../../monitoring/service.monitor.js';
import { serviceStateRu } from '../../monitoring/service.monitor.js';
import type { NetworkSnapshot } from '../../monitoring/network.monitor.js';
import type { EventLogSnapshot } from '../../monitoring/eventlog.monitor.js';
import { worstLevel, type Level } from '../../monitoring/types.js';
import { EMOJI, esc } from '../notifications/formatter.js';
import type { Notifier } from '../notifications/notifier.js';
import { fmtDateTime, fmtDuration, fmtShort } from '../../utils/time.js';

export interface ViewDeps {
  core: MonitoringCore;
  db: Database;
  notifier: Notifier;
  version: string;
}

const LEVEL_RU: Record<Level, string> = { OK: 'Норма', WARNING: 'Предупреждение', CRITICAL: 'Критично' };

function age(at?: number): string {
  return at ? `${fmtDateTime(at)} (${fmtDuration(Date.now() - at)} назад)` : 'ещё не выполнялась';
}

function header(title: string, deps: ViewDeps): string {
  const s = deps.core.server;
  return `<b>${esc(title)}</b>\n${esc(s.name)} · ${esc(s.ip)}\n`;
}

function quikLevel(deps: ViewDeps): { level: Level | null; text: string } {
  const { core } = deps;
  const p = core.snapshot<ProcessSnapshot>('process');
  const sv = core.snapshot<ServiceSnapshot>('service');
  const n = core.snapshot<NetworkSnapshot>('network');
  const configured = core.isEnabled('process') || core.isEnabled('service') || core.isEnabled('network');
  if (!configured) return { level: null, text: '⚪ не настроено (заполните config.json)' };
  const levels: Level[] = [];
  const tr = core.tracker;
  for (const x of p.data?.processes ?? []) levels.push(tr.level(`process:${x.image.toLowerCase()}`));
  for (const x of sv.data?.services ?? []) levels.push(tr.level(`service:${x.name.toLowerCase()}`));
  for (const x of n.data?.ports ?? []) levels.push(tr.level(`port:${x.mode}:${x.host}:${x.port}`));
  const lvl = worstLevel(levels);
  const total = levels.length;
  const bad = levels.filter((l) => l !== 'OK').length;
  return { level: lvl, text: `${EMOJI[lvl]} ${bad === 0 ? 'работает' : `проблем: ${bad} из ${total}`}` };
}

export function viewStatus(deps: ViewDeps): string {
  const { core } = deps;
  const sys = core.snapshot<SystemSnapshot>('system').data;
  const overall = core.overall();
  const quik = quikLevel(deps);
  const tg = deps.notifier.status();

  const lines = [header('📊 Состояние сервера', deps)];
  lines.push(`Общее состояние: ${EMOJI[overall]} ${LEVEL_RU[overall]}`);
  lines.push(`QUIK: ${quik.text}`);
  if (sys) {
    lines.push(`CPU: ${EMOJI[sys.cpuLevel]} ${sys.cpuPercent.toFixed(0)}%`);
    lines.push(`RAM: ${EMOJI[sys.ramLevel]} ${sys.ramPercent.toFixed(0)}% (${fmtGb(sys.ramUsedBytes)} / ${fmtGb(sys.ramTotalBytes)})`);
    for (const d of sys.disks) {
      lines.push(d.error ? `Disk ${d.drive}: 🔴 ошибка чтения` : `Disk ${d.drive}: ${EMOJI[d.level]} свободно ${d.freePercent.toFixed(1)}% (${fmtGb(d.freeBytes)})`);
    }
  } else {
    lines.push('Ресурсы: данные ещё не собраны');
  }

  const problems = core.tracker.problems();
  if (problems.length) {
    lines.push('', '<b>Активные проблемы:</b>');
    for (const p of problems) {
      const subj = p.obs ? `${p.obs.alertTitle} — ${p.obs.subject[1]}` : p.key;
      lines.push(`${EMOJI[p.level]} ${esc(subj)} (${fmtDuration(Date.now() - p.since)})`);
    }
  }
  lines.push('', `Последняя проверка: ${core.lastCheckAt ? fmtDateTime(core.lastCheckAt) : '—'}`);
  if (!tg.online || tg.pending > 0) lines.push(`Очередь уведомлений: ${tg.pending}`);
  return lines.join('\n');
}

export function viewProcesses(deps: ViewDeps): string {
  const { core } = deps;
  const lines = [header('⚙️ Процессы QUIK', deps)];
  if (!core.isEnabled('process')) return lines.concat('Процессы не настроены (config.json → processes).').join('\n');
  const snap = core.snapshot<ProcessSnapshot>('process');
  if (snap.error) lines.push(`⚠️ Ошибка последней проверки: ${esc(snap.error)}`);
  for (const p of snap.data?.processes ?? []) {
    const key = `process:${p.image.toLowerCase()}`;
    const lvl = core.tracker.level(key);
    const since = core.tracker.since(key);
    const mem = p.instances.reduce((a, i) => a + i.memKb, 0);
    lines.push(
      `${EMOJI[lvl]} <b>${esc(p.label)}</b> (${esc(p.image)})`,
      p.instances.length
        ? `   PID: ${p.instances.map((i) => i.pid).join(', ')} · память: ${(mem / 1024).toFixed(0)} МБ`
        : '   ❌ процесс не найден',
    );
    if (lvl !== 'OK' && since) lines.push(`   DOWN с ${fmtDateTime(since)} (${fmtDuration(Date.now() - since)})`);
  }
  lines.push('', `Проверено: ${age(snap.at)}`);
  return lines.join('\n');
}

export function viewServices(deps: ViewDeps): string {
  const { core } = deps;
  const lines = [header('🧩 Службы Windows', deps)];
  if (!core.isEnabled('service')) return lines.concat('Службы не настроены (config.json → services).').join('\n');
  const snap = core.snapshot<ServiceSnapshot>('service');
  if (snap.error) lines.push(`⚠️ Ошибка последней проверки: ${esc(snap.error)}`);
  for (const s of snap.data?.services ?? []) {
    const lvl = core.tracker.level(`service:${s.name.toLowerCase()}`);
    lines.push(`${EMOJI[lvl]} <b>${esc(s.label)}</b> (${esc(s.name)}): ${serviceStateRu(s.state)}${s.pid ? ` · PID ${s.pid}` : ''}`);
  }
  lines.push('', `Проверено: ${age(snap.at)}`);
  return lines.join('\n');
}

export function viewResources(deps: ViewDeps): string {
  const { core } = deps;
  const snap = core.snapshot<SystemSnapshot>('system');
  const s = snap.data;
  const lines = [header('📈 Ресурсы', deps)];
  if (!s) return lines.concat('Данные ещё не собраны.').join('\n');
  lines.push(
    `CPU: ${EMOJI[s.cpuLevel]} ${s.cpuPercent.toFixed(1)}% (${s.cpuCount} лог. процессоров)`,
    `RAM: ${EMOJI[s.ramLevel]} ${s.ramPercent.toFixed(1)}% — ${fmtGb(s.ramUsedBytes)} из ${fmtGb(s.ramTotalBytes)}`,
    '',
    '<b>Диски:</b>',
  );
  for (const d of s.disks) {
    lines.push(
      d.error
        ? `🔴 ${d.drive} ошибка: ${esc(d.error)}`
        : `${EMOJI[d.level]} ${d.drive} свободно ${fmtGb(d.freeBytes)} из ${fmtGb(d.totalBytes)} (${d.freePercent.toFixed(1)}%)`,
    );
  }
  lines.push('', `Проверено: ${age(snap.at)}`);
  return lines.join('\n');
}

export function viewNetwork(deps: ViewDeps): string {
  const { core, notifier } = deps;
  const lines = [header('🌐 Сеть', deps)];
  if (!core.isEnabled('network')) {
    lines.push('Порты не настроены (config.json → ports).');
  } else {
    const snap = core.snapshot<NetworkSnapshot>('network');
    if (snap.error) lines.push(`⚠️ Ошибка последней проверки: ${esc(snap.error)}`);
    for (const p of snap.data?.ports ?? []) {
      const lvl = core.tracker.level(`port:${p.mode}:${p.host}:${p.port}`);
      const detail = p.ok
        ? p.mode === 'listen'
          ? `слушается${p.pids?.length ? ` (PID ${p.pids.join(', ')})` : ''}`
          : `доступен, ${p.latencyMs} мс`
        : esc(p.error ?? 'недоступен');
      lines.push(`${EMOJI[lvl]} <b>${esc(p.label)}</b> ${esc(p.host)}:${p.port} [${p.mode}] — ${detail}`);
    }
    lines.push('', `Проверено: ${age(snap.at)}`);
  }
  const tg = notifier.status();
  lines.push('', `Telegram: ${tg.online ? '🟢 связь есть' : `🔴 нет связи с ${tg.offlineSince ? fmtDateTime(tg.offlineSince) : '—'}`}`);
  return lines.join('\n');
}

export function viewHistory(deps: ViewDeps, limit = 15): string {
  const rows = deps.db.recentIncidents(limit);
  const lines = [header('🗂 Последние инциденты', deps)];
  if (rows.length === 0) return lines.concat('Инцидентов не зафиксировано.').join('\n');
  for (const r of rows) {
    const end = r.ended_at ? `${fmtShort(r.ended_at).slice(6)} (${fmtDuration(r.ended_at - r.started_at)})` : `продолжается (${fmtDuration(Date.now() - r.started_at)})`;
    const icon = r.ended_at ? '✅' : EMOJI[r.severity];
    lines.push(`${icon} ${fmtShort(r.started_at)} → ${end}\n    ${esc(r.title)}: ${esc(r.subject)}`);
  }
  return lines.join('\n');
}

export function viewUptime(deps: ViewDeps): string {
  const s = deps.core.snapshot<SystemSnapshot>('system').data;
  const uptimeSec = s?.uptimeSec ?? os.uptime();
  const boot = Date.now() - uptimeSec * 1000;
  const lines = [header('⏱ Uptime', deps)];
  lines.push(
    `Сервер работает: ${fmtDuration(uptimeSec * 1000)}`,
    `Последняя загрузка: ${fmtDateTime(boot)}`,
    `ОС: ${esc(s?.osVersion ?? os.version())} (${esc(s?.osRelease ?? os.release())})`,
    '',
    `Мониторинг работает: ${fmtDuration(Date.now() - deps.core.appStartedAt)}`,
    `Версия бота: ${esc(deps.version)}`,
  );
  const ev = deps.core.snapshot<EventLogSnapshot>('eventlog').data;
  if (ev) lines.push(`Журналы Windows проверены: ${ev.sources.map((x) => esc(x.log)).join(', ')}`);
  return lines.join('\n');
}

export const HELP = [
  '<b>Команды мониторинга QUIK</b>',
  '',
  '/status — сводка состояния сервера',
  '/processes — процессы QUIK',
  '/services — службы Windows',
  '/resources — CPU, RAM, диски',
  '/network — порты и связь с Telegram',
  '/history — последние инциденты',
  '/uptime — время работы сервера',
  '/help — эта справка',
  '',
  '🔴 CRITICAL · 🟠 WARNING · 🟢 норма/восстановлено',
  'Бот работает только на чтение и не управляет QUIK.',
].join('\n');
