import type { Transition } from '../../core/state-tracker.js';
import type { InfoEvent, Level, Line } from '../../monitoring/types.js';
import { fmtDateTime, fmtDuration } from '../../utils/time.js';

export interface ServerInfo {
  name: string;
  ip: string;
}

export const EMOJI: Record<Level, string> = { OK: '🟢', WARNING: '🟠', CRITICAL: '🔴' };

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function lines(ls: Line[]): string {
  return ls.map(([k, v]) => `${esc(k)}: ${esc(v)}`).join('\n');
}

/** Проблема или изменение её серьёзности. */
export function formatAlert(t: Transition, server: ServerInfo): string {
  const o = t.obs;
  const head = `${EMOJI[t.to]} <b>${t.to}: ${esc(o.alertTitle)}</b>`;
  const ls: Line[] = [['Сервер', server.name], ['IP', server.ip], o.subject, ...o.details];
  if (o.event) ls.push(['Событие', o.event]);
  ls.push(['Время', fmtDateTime(t.at)]);
  if (o.status) ls.push(['Статус', o.status]);
  if (t.from !== 'OK') ls.push(['Изменение', `${t.from} → ${t.to}`]);
  return `${head}\n\n${lines(ls)}`;
}

export function formatRecovered(t: Transition, server: ServerInfo): string {
  const o = t.obs;
  const head = `🟢 <b>RECOVERED: ${esc(o.recoveredTitle)}</b>`;
  const ls: Line[] = [['Сервер', server.name], o.subject];
  if (o.kind === 'cpu' || o.kind === 'ram' || o.kind === 'disk') ls.push(...o.details);
  ls.push(['Время восстановления', fmtDateTime(t.at)]);
  ls.push(['Продолжительность сбоя', fmtDuration(t.at - t.incidentStart)]);
  return `${head}\n\n${lines(ls)}`;
}

export function formatTransition(t: Transition, server: ServerInfo): string {
  return t.to === 'OK' ? formatRecovered(t, server) : formatAlert(t, server);
}

export function formatInfoEvent(ev: InfoEvent, server: ServerInfo, at: number): string {
  const head = `${EMOJI[ev.level]} <b>${ev.level}: ${esc(ev.title)}</b>`;
  const ls: Line[] = [['Сервер', server.name], ...ev.details, ['Время', fmtDateTime(at)]];
  return `${head}\n\n${lines(ls)}`;
}

/** Сообщение после окна обслуживания: проблема сохраняется. */
export function formatStillDown(title: string, subject: Line, level: Level, since: number, server: ServerInfo, now: number): string {
  const head = `${EMOJI[level]} <b>${level}: ${esc(title)}</b>`;
  const ls: Line[] = [
    ['Сервер', server.name],
    ['IP', server.ip],
    subject,
    ['Событие', 'проблема сохраняется после окончания окна обслуживания'],
    ['Начало', fmtDateTime(since)],
    ['Длительность', fmtDuration(now - since)],
  ];
  return `${head}\n\n${lines(ls)}`;
}

export function formatPlain(emoji: string, title: string, ls: Line[]): string {
  return `${emoji} <b>${esc(title)}</b>\n\n${lines(ls)}`;
}
