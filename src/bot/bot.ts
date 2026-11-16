import type { Agent } from 'node:https';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { Telegraf, Telegram, type Context, type MiddlewareFn } from 'telegraf';
import { errMsg, type Logger } from '../logger/index.js';
import { COMMANDS, registerCommands } from './commands/index.js';
import type { ViewDeps } from './commands/views.js';

export interface BotOptions {
  token: string;
  adminId: number;
  proxyUrl?: string;
  log: Logger;
}

function makeAgent(proxyUrl?: string): Agent | undefined {
  return proxyUrl ? (new HttpsProxyAgent(proxyUrl) as unknown as Agent) : undefined;
}

/** Клиент только для отправки уведомлений (независим от long polling). */
export function createSender(opts: BotOptions): (text: string) => Promise<void> {
  const telegram = new Telegram(opts.token, { agent: makeAgent(opts.proxyUrl) });
  return async (text: string) => {
    await telegram.sendMessage(opts.adminId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  };
}

/** Доступ только владельцу и только в личном чате. Посторонним бот не отвечает. */
function authGuard(adminId: number, log: Logger): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    if (fromId === adminId && ctx.chat?.type === 'private') return next();
    log.warn({ fromId, chatType: ctx.chat?.type, updateType: ctx.updateType }, 'Отклонён запрос от неавторизованного пользователя');
  };
}

/**
 * Приём команд через long polling с автоматическим перезапуском при сбоях сети.
 * Уведомления отправляются отдельным клиентом и не зависят от состояния polling.
 */
export class CommandBot {
  private bot?: Telegraf;
  private stopped = false;
  private loop?: Promise<void>;

  constructor(
    private readonly opts: BotOptions,
    private readonly deps: ViewDeps,
  ) {}

  private build(): Telegraf {
    const bot = new Telegraf(this.opts.token, {
      handlerTimeout: 30_000,
      telegram: { agent: makeAgent(this.opts.proxyUrl) },
    });
    bot.use(authGuard(this.opts.adminId, this.opts.log));
    registerCommands(bot, this.deps);
    bot.catch((err, ctx) => {
      this.opts.log.error({ err: errMsg(err), update: ctx.updateType }, 'Ошибка обработки команды');
    });
    return bot;
  }

  start(): void {
    this.loop = this.run();
  }

  private async run(): Promise<void> {
    let delay = 5_000;
    while (!this.stopped) {
      const bot = this.build();
      this.bot = bot;
      try {
        await bot.telegram.setMyCommands(COMMANDS).catch(() => undefined);
        this.opts.log.info('Telegram: приём команд запущен');
        // dropPendingUpdates: команды, накопившиеся пока бот не работал, не выполняются
        await bot.launch({ dropPendingUpdates: true, allowedUpdates: ['message'] });
        delay = 5_000;
      } catch (err) {
        if (this.stopped) break;
        this.opts.log.warn({ err: errMsg(err), retryInMs: delay }, 'Telegram polling остановлен с ошибкой, перезапуск');
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
