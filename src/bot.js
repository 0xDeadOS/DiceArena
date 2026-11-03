/**
 * PATH OF DICE — src/bot.js
 * Минималистичный Telegram-бот (grammy). ТОЛЬКО три команды: /start, /help, /web.
 * Вся игра происходит в Web Mini App — здесь лишь авторизация и вход.
 */

import { Bot, InlineKeyboard } from 'grammy';

import { buildSignedLink, isUrlTelegramSafe, signToken } from './auth.js';
import { formatDailyHint, formatDieCardHtml } from './diceCard.js';
import { GameStore } from './store.js';

export function getWebAppUrl() {
  const raw = process.env.WEBAPP_URL || `http://localhost:${process.env.PORT || 3000}`;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname === '/' ? '/' : '/'}`;
  } catch {
    return `http://localhost:${process.env.PORT || 3000}/`;
  }
}

/**
 * Собирает клавиатуру входа: web_app (если HTTPS) + подписанная ссылка.
 */
export function buildEntryKeyboard({ playerId, baseUrl = getWebAppUrl(), token = null }) {
  const keyboard = new InlineKeyboard();
  const webUrl = new URL(baseUrl);
  if (token) webUrl.searchParams.set('token', token);
  const signedUrl = buildSignedLink({ playerId, baseUrl });

  if (isUrlTelegramSafe(webUrl.toString())) {
    keyboard.webApp('🎲 Открыть Кубик Изгнанника', webUrl.toString()).row();
  }
  keyboard.url('🔐 Войти по персональной ссылке', signedUrl).row();
  keyboard.url('📖 Кодекс в браузере', `${baseUrl.replace(/\/$/, '')}/#codex`);
  return keyboard;
}

/**
 * Регистрирует игрока и отдаёт карточку кубика.
 */
export function prepareEntry(store, from) {
  const { player, created, linked } = store.ensureTelegramPlayer(from);
  store.ensureDay(player);
  const level = Math.floor(1 + Math.log2(1 + (player.xp || 0) / 40));
  const card = formatDieCardHtml(store.getEquippedDie(player), {
    playerName: player.name,
    playerLevel: Math.max(1, level),
  });
  const hint = formatDailyHint(player);
  const token = signToken({
    playerId: player.id,
    telegramId: player.telegramId,
    admin: store.isAdmin(player),
  });
  return { player, created, linked, text: `${card}\n\n${hint}`, token };
}

export function createBot({
  token = process.env.BOT_TOKEN,
  store,
  log = console.log,
} = {}) {
  if (!token) {
    log('[bot] BOT_TOKEN не задан — бот выключен, Web App работает автономно.');
    return null;
  }
  if (!store) throw new Error('createBot требует GameStore');

  const bot = new Bot(token);

  const replyWithEntry = async (ctx) => {
    const { player, created, text, token: sessionToken } = prepareEntry(store, ctx.from);
    if (created) {
      log(`[bot] Новый игрок: ${player.name} (${player.id})`);
    }
    const keyboard = buildEntryKeyboard({ playerId: player.id, token: sessionToken });
    await ctx.reply(text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  };

  bot.command('start', async (ctx) => {
    await replyWithEntry(ctx);
  });

  bot.command('help', async (ctx) => {
    const { formatHelpHtml } = await import('./diceCard.js');
    const { player } = store.ensureTelegramPlayer(ctx.from);
    const keyboard = buildEntryKeyboard({ playerId: player.id });
    await ctx.reply(formatHelpHtml(), {
      parse_mode: 'HTML',
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true },
    });
  });

  bot.command('web', async (ctx) => {
    const { player } = store.ensureTelegramPlayer(ctx.from);
    const token = signToken({
      playerId: player.id,
      telegramId: player.telegramId,
      admin: store.isAdmin(player),
    });
    const keyboard = buildEntryKeyboard({ playerId: player.id, token });
    await ctx.reply(
      `🔐 <b>Персональный вход</b>\n\nСсылка привязана к вашему профилю <b>${player.name}</b> и подписана HMAC-SHA256.\n\n<i>Открывайте только со своего устройства.</i>`,
      { parse_mode: 'HTML', reply_markup: keyboard, link_preview_options: { is_disabled: true } },
    );
  });

  bot.catch((error) => {
    log(`[bot] Ошибка: ${error.message}`);
  });

  return bot;
}

/** Запуск бота вместе с автономным стором (npm run bot). */
export async function runStandaloneBot() {
  const store = new GameStore();
  store.load();
  const bot = createBot({ store });
  if (!bot) return null;
  await bot.api.setMyCommands([
    { command: 'start', description: 'Карточка кубика и вход в игру' },
    { command: 'help', description: 'Справка по игре' },
    { command: 'web', description: 'Персональная ссылка в Mini App' },
  ]);
  log('[bot] Long polling запущен. Команды: /start /help /web');
  await bot.start({ drop_pending_updates: true, onStart: (info) => log(`[bot] @${info.username} готов.`) });
  return bot;
}

const isDirectRun = process.argv[1] && process.argv[1].endsWith('bot.js');
if (isDirectRun) {
  import('dotenv').then(({ default: dotenv }) => dotenv.config());
  runStandaloneBot().catch((error) => {
    console.error('[bot] Фатальная ошибка:', error);
    process.exitCode = 1;
  });
}
