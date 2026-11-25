import type { Agent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Telegraf, Telegram, type Context, type MiddlewareFn } from 'telegraf';
import { errMsg, type Logger } from './logger.js';
import { findServices, isValidServiceName, queryService, stateRu, type ServiceStore } from './services.js';
import type { Transition, Watcher } from './watcher.js';

export interface BotOptions {
  token: string;
  adminIds: number[];
  proxyUrl?: string;
  serverName: string;
  timezone: string;
  log: Logger;
}

// ---------- форматирование ----------

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function fmtTime(ts: number, timeZone: string): string {
  return new Date(ts).toLocaleString('ru-RU', { timeZone, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function fmtDuration(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (d) return `${d} д ${h} ч`;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${s} с`;
  return `${s} с`;
}

export function formatTransition(t: Transition, serverName: string, tz: string): string {
  const svc = `<b>${esc(t.service.label)}</b> (<code>${esc(t.service.name)}</code>)`;
  if (t.kind === 'down') {
    return [`🔴 <b>Служба не работает</b>`, `Сервер: ${esc(serverName)}`, `Служба: ${svc}`, `Состояние: ${stateRu(t.state)}`, `Время: ${fmtTime(t.at, tz)}`].join('\n');
  }
  return [`🟢 <b>Служба снова работает</b>`, `Сервер: ${esc(serverName)}`, `Служба: ${svc}`, `Время: ${fmtTime(t.at, tz)}`, `Простой: ${fmtDuration(t.at - t.downSince)}`].join('\n');
}

const HELP = [
  '<b>Команды</b>',
  '/status — состояние отслеживаемых служб',
  '/add <code>имя</code> [название] — добавить службу',
  '/remove <code>имя</code> — убрать службу',
  '/find <code>текст</code> — найти службу на сервере',
  '/help — эта справка',
  '',
  'Имя — короткое имя службы Windows (Name), например <code>QuikServerQ</code>.',
  'Не знаете имя — найдите через /find.',
].join('\n');

const COMMANDS = [
  { command: 'status', description: 'Состояние служб' },
  { command: 'add', description: 'Добавить службу: /add имя [название]' },
  { command: 'remove', description: 'Убрать службу: /remove имя' },
  { command: 'find', description: 'Найти службу: /find текст' },
  { command: 'help', description: 'Справка' },
];

// ---------- Telegram ----------

function makeAgent(proxyUrl?: string): Agent | undefined {
  return proxyUrl ? (new HttpsProxyAgent(proxyUrl) as unknown as Agent) : undefined;
}

/** Отправка уведомления всем админам (с повторами при сбое сети). */
export function createSender(opts: BotOptions): (html: string) => Promise<void> {
  const telegram = new Telegram(opts.token, { agent: makeAgent(opts.proxyUrl) });
  return async (html: string) => {
    for (const chatId of opts.adminIds) {
      for (let attempt = 1; attempt <= 5; attempt++) {
        try {
          await telegram.sendMessage(chatId, html, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          break;
        } catch (err) {
          opts.log.warn({ chatId, attempt, err: errMsg(err) }, 'Не удалось отправить уведомление');
          if (attempt < 5) await new Promise((r) => setTimeout(r, attempt * 5000));
        }
      }
    }
  };
}

/** Команды принимаются только от админов и только в личном чате. Посторонним бот не отвечает. */
function authGuard(adminIds: number[], log: Logger): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId !== undefined && adminIds.includes(fromId) && ctx.chat?.type === 'private') return next();
    log.warn({ fromId, chatType: ctx.chat?.type }, 'Отклонён запрос от неавторизованного пользователя');
  };
}

function args(ctx: Context): string[] {
  const text = ctx.message && 'text' in ctx.message ? ctx.message.text : '';
  return text.trim().split(/\s+/).slice(1);
}

async function reply(ctx: Context, html: string): Promise<void> {
  const text = html.length > 4000 ? `${html.slice(0, 4000)}\n…` : html;
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

export class CommandBot {
  private bot?: Telegraf;
  private stopped = false;
  private loop?: Promise<void>;

  constructor(
    private readonly opts: BotOptions,
    private readonly store: ServiceStore,
    private readonly watcher: Watcher,
  ) {}

  private statusText(): string {
    const items = this.watcher.view();
    const lines = [`🖥 <b>${esc(this.opts.serverName)}</b>`, ''];
    if (items.length === 0) {
      lines.push('Список служб пуст. Добавьте: /add <code>имя</code>');
      return lines.join('\n');
    }
    for (const s of items) {
      const icon = s.state === undefined ? '⏳' : s.down ? '🔴' : s.state === 'RUNNING' ? '✅' : '⚠️';
      const state = s.state === undefined ? 'ещё не проверена' : stateRu(s.state);
      lines.push(`${icon} ${esc(s.label)} (<code>${esc(s.name)}</code>) — ${state}`);
    }
    if (this.watcher.lastCheckAt) lines.push('', `Проверено: ${fmtTime(this.watcher.lastCheckAt, this.opts.timezone)}`);
    return lines.join('\n');
  }

  private register(bot: Telegraf): void {
    bot.start((ctx) => reply(ctx, `👋 Бот следит за службами Windows на сервере <b>${esc(this.opts.serverName)}</b>.\n\n${HELP}`));
    bot.help((ctx) => reply(ctx, HELP));

    bot.command('status', (ctx) => reply(ctx, this.statusText()));

    bot.command('add', async (ctx) => {
      const [name, ...rest] = args(ctx);
      if (!name) return reply(ctx, 'Укажите имя службы: /add <code>QuikServerQ</code> [название]');
      if (!isValidServiceName(name)) return reply(ctx, 'Недопустимое имя. Нужно короткое имя службы без пробелов. Найти его: /find <code>текст</code>');
      if (this.store.get(name)) return reply(ctx, `Служба <code>${esc(name)}</code> уже в списке.`);

      const state = await queryService(name);
      if (state === 'NOT_FOUND') return reply(ctx, `❌ Служба <code>${esc(name)}</code> не найдена на сервере. Найти имя: /find <code>текст</code>`);

      const label = rest.join(' ').slice(0, 64) || name;
      this.store.add({ name, label });
      this.opts.log.info({ service: name, by: ctx.from?.id }, 'Служба добавлена');
      await reply(ctx, `✅ Добавлена: <b>${esc(label)}</b> (<code>${esc(name)}</code>)\nСейчас: ${stateRu(state)}`);
      void this.watcher.checkAll();
    });

    bot.command('remove', async (ctx) => {
      const [name] = args(ctx);
      if (!name) return reply(ctx, 'Укажите имя службы: /remove <code>QuikServerQ</code>');
      const removed = this.store.remove(name);
      if (!removed) return reply(ctx, `Службы <code>${esc(name)}</code> нет в списке. Список: /status`);
      this.watcher.forget(removed.name);
      this.opts.log.info({ service: removed.name, by: ctx.from?.id }, 'Служба удалена');
      await reply(ctx, `🗑 Убрана: <b>${esc(removed.label)}</b> (<code>${esc(removed.name)}</code>)`);
    });

    bot.command('find', async (ctx) => {
      const text = args(ctx).join(' ');
      if (text.length < 2) return reply(ctx, 'Укажите часть имени: /find <code>quik</code>');
      const found = await findServices(text);
      if (found.length === 0) return reply(ctx, `Ничего не найдено по «${esc(text)}».`);
      const lines = found.slice(0, 25).map((s) => `• <code>${esc(s.name)}</code> — ${esc(s.displayName)}${this.store.get(s.name) ? ' ✔️' : ''}`);
      if (found.length > 25) lines.push(`…и ещё ${found.length - 25}, уточните запрос`);
      lines.push('', 'Добавить: /add <code>имя</code> [название]');
      await reply(ctx, lines.join('\n'));
    });

    bot.on('message', (ctx) => reply(ctx, 'Неизвестная команда. /help — справка.'));
  }

  private build(): Telegraf {
    const bot = new Telegraf(this.opts.token, { handlerTimeout: 30_000, telegram: { agent: makeAgent(this.opts.proxyUrl) } });
    bot.use(authGuard(this.opts.adminIds, this.opts.log));
    this.register(bot);
    bot.catch((err, ctx) => {
      this.opts.log.error({ err: errMsg(err) }, 'Ошибка обработки команды');
      void ctx.reply('⚠️ Ошибка при выполнении команды, подробности в логе.').catch(() => undefined);
    });
    return bot;
  }

  start(): void {
    this.loop = this.run();
  }

  /** Long polling с автоматическим перезапуском при сбоях сети. */
  private async run(): Promise<void> {
    let delay = 5_000;
    while (!this.stopped) {
      const bot = this.build();
      this.bot = bot;
      try {
        await bot.telegram.setMyCommands(COMMANDS).catch(() => undefined);
        this.opts.log.info('Telegram: приём команд запущен');
        await bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message'] });
        delay = 5_000;
      } catch (err) {
        if (this.stopped) break;
        const msg = errMsg(err);
        const hint = msg.includes('409') ? ' (этот же бот запущен где-то ещё — оставьте один экземпляр)' : '';
        this.opts.log.warn({ err: msg, retryInMs: delay }, `Telegram polling остановлен с ошибкой${hint}`);
        try {
          bot.stop('restart');
        } catch {
          /* not running */
        }
      }
      if (this.stopped) break;
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 120_000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    try {
      this.bot?.stop('shutdown');
    } catch {
      /* not running */
    }
    await Promise.race([this.loop, new Promise((r) => setTimeout(r, 5000))]);
  }
}
