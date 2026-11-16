import type { Context, Telegraf } from 'telegraf';
import { HELP, viewHistory, viewNetwork, viewProcesses, viewResources, viewServices, viewStatus, viewUptime, type ViewDeps } from './views.js';

export const COMMANDS: { command: string; description: string }[] = [
  { command: 'status', description: 'Сводка состояния сервера' },
  { command: 'processes', description: 'Процессы QUIK' },
  { command: 'services', description: 'Службы Windows' },
  { command: 'resources', description: 'CPU, RAM, диски' },
  { command: 'network', description: 'Сетевые проверки' },
  { command: 'history', description: 'Последние инциденты' },
  { command: 'uptime', description: 'Время работы сервера' },
  { command: 'help', description: 'Список команд' },
];

const MAX_LEN = 4000;

async function reply(ctx: Context, html: string): Promise<void> {
  const text = html.length > MAX_LEN ? `${html.slice(0, MAX_LEN)}\n…` : html;
  await ctx.reply(text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

export function registerCommands(bot: Telegraf, deps: ViewDeps): void {
  bot.start((ctx) => reply(ctx, `👋 <b>Мониторинг сервера QUIK активен.</b>\n\n${HELP}`));
  bot.help((ctx) => reply(ctx, HELP));
  bot.command('status', (ctx) => reply(ctx, viewStatus(deps)));
  bot.command('processes', (ctx) => reply(ctx, viewProcesses(deps)));
  bot.command('services', (ctx) => reply(ctx, viewServices(deps)));
  bot.command('resources', (ctx) => reply(ctx, viewResources(deps)));
  bot.command('network', (ctx) => reply(ctx, viewNetwork(deps)));
  bot.command('history', (ctx) => reply(ctx, viewHistory(deps)));
  bot.command('uptime', (ctx) => reply(ctx, viewUptime(deps)));
  bot.on('message', (ctx) => reply(ctx, 'Неизвестная команда. /help — список команд.'));
}
