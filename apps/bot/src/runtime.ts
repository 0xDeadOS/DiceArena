/**
 * Переиспользуемые части бота для встраивания в другой процесс.
 *
 * `index.ts` остаётся самостоятельной точкой входа для отдельного
 * background-воркера; `runtime.ts` собирает то же самое из общих деталей,
 * чтобы API мог поднять бота в своём процессе (см. apps/api/src/combined.ts).
 */
import type { Bot } from 'grammy';
import type { PrismaClient, PrismaRoomRepository } from '@dicebound/db';
import { buildBot } from './bot.js';
import { startAnnouncementDispatcher } from './announce.js';

export interface BotRuntime {
  bot: Bot;
  /** Останавливает диспетчер анонсов и long polling. */
  stop(): Promise<void>;
}

export interface BotRuntimeOptions {
  botToken: string;
  appShortName: string;
  rooms: PrismaRoomRepository;
  db: PrismaClient;
  /**
   * Предел ожидания сетевых вызовов Bot API при старте, мс.
   *
   * Без него недоступный `api.telegram.org` оставляет промис неразрешённым
   * навсегда: процесс остаётся живым, бот не работает, и в логах нет ни
   * готовности, ни ошибки.
   */
  startupTimeoutMs?: number;
  log?: {
    info: (message: string) => void;
    warn: (message: string) => void;
  };
}

/**
 * Поднимает бота на long polling вместе с диспетчером анонсов.
 *
 * Отказ при настроенном webhook обязателен: `bot.start()` удаляет webhook,
 * поэтому молчаливый захват чужого webhook-бота потерял бы его обновления.
 */
export async function startBotRuntime(options: BotRuntimeOptions): Promise<BotRuntime> {
  const info = options.log?.info ?? ((message: string) => console.info(message));
  const warn = options.log?.warn ?? ((message: string) => console.warn(message));

  const bot = buildBot(options.botToken, options.appShortName, options.rooms);
  const stopAnnouncements = startAnnouncementDispatcher({
    db: options.db,
    send: (chatId, text) => bot.api.sendMessage(chatId.toString(), text),
    log: warn,
  });

  const timeoutMs = options.startupTimeoutMs ?? 30_000;
  const withTimeout = <T>(promise: Promise<T>, step: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Bot startup timed out after ${timeoutMs} ms at step: ${step}`));
        }, timeoutMs);
        // Таймер не должен удерживать процесс при корректном завершении.
        timer.unref();
      }),
    ]);

  try {
    await withTimeout(bot.init(), 'getMe');
    const webhook = await withTimeout(bot.api.getWebhookInfo(), 'getWebhookInfo');
    if (webhook.url) throw new Error('Configured webhook: long polling startup refused');
    await withTimeout(
      bot.api.setMyCommands([
        { command: 'game', description: 'Войти в Обитель чата' },
        { command: 'start', description: 'Как начать играть' },
        { command: 'help', description: 'Правила и помощь' },
      ]),
      'setMyCommands',
    );
    await withTimeout(
      bot.start({
        allowed_updates: ['message', 'my_chat_member'],
        onStart: () => info('Dicebound bot is running.'),
      }),
      'getUpdates',
    );
  } catch (error) {
    stopAnnouncements();
    if (bot.isRunning()) await bot.stop();
    throw error;
  }

  return {
    bot,
    async stop() {
      stopAnnouncements();
      if (bot.isRunning()) await bot.stop();
    },
  };
}
