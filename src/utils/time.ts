let timeZone = 'Asia/Bishkek';
let dateTimeFmt = makeFmt();

function makeFmt(): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('ru-RU', {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function setTimeZone(tz: string): void {
  timeZone = tz;
  dateTimeFmt = makeFmt();
}

export function getTimeZone(): string {
  return timeZone;
}

/** 13.11.2026 14:05:12 */
export function fmtDateTime(ms: number): string {
  return dateTimeFmt.format(new Date(ms)).replace(',', '');
}

/** 13.11 14:05 */
export function fmtShort(ms: number): string {
  const full = fmtDateTime(ms); // dd.mm.yyyy hh:mm:ss
  return `${full.slice(0, 5)} ${full.slice(11, 16)}`;
}

export function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  if (b === 1) return forms[0];
  return forms[2];
}

/** 4 минуты; 1 час 5 минут; 2 дня 3 часа; 45 секунд */
export function fmtDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d} ${plural(d, ['день', 'дня', 'дней'])}`);
  if (h) parts.push(`${h} ${plural(h, ['час', 'часа', 'часов'])}`);
  if (m && !d) parts.push(`${m} ${plural(m, ['минута', 'минуты', 'минут'])}`);
  if (!d && !h && !m) parts.push(`${s} ${plural(s, ['секунда', 'секунды', 'секунд'])}`);
  return parts.join(' ');
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

/** День недели и минуты от полуночи в настроенном часовом поясе. */
export function localClock(ms: number): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday').toLowerCase().slice(0, 3) as Weekday;
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  return { weekday, minutes: hour * 60 + minute };
}

export function prevWeekday(d: Weekday): Weekday {
  const i = WEEKDAYS.indexOf(d);
  return WEEKDAYS[(i + 6) % 7]!;
}
