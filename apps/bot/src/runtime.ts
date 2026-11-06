/**
 * Переиспользуемые части бота для встраивания в другой процесс.
 *
 * `index.ts` остаётся самостоятельной точкой входа для отдельного
 * background-воркера; `runtime.ts` собирает то же самое из общих деталей,
 * чтобы API мог поднять бота в своём процессе (см. apps/api/src/combined.ts).
 */
import { InputFile, type Bot } from 'grammy';
import type { PrismaClient, PrismaRoomRepository } from '@dicebound/db';
import { buildBot } from './bot.js';
import { startAnnouncementDispatcher } from './announce.js';
import { runBackup, startBackupScheduler } from './backup.js';
import type { BackupChannel } from './backup.js';

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
  /**
   * Личные сообщения админа для резервных копий базы.
   * Не задано — копирование выключено.
   */
  backup?: {
    chatId: bigint;
    intervalMs?: number;
  };
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

  let stopBackup: (() => void) | undefined;
  if (options.backup) {
    const { chatId } = options.backup;
    const channel: BackupChannel = {
      sendDocument: (bytes, filename, caption) =>
        bot.api.sendDocument(chatId.toString(), new InputFile(bytes, filename), { caption }),
      sendText: (text) => bot.api.sendMessage(chatId.toString(), text),
    };

    // Полный снимок базы — это данные всех игроков, поэтому команда доступна
    // только в личных сообщениях админа и больше нигде.
    bot.command('backup', async (ctx) => {
      if (ctx.chat.type !== 'private' || BigInt(ctx.chat.id) !== chatId) {
        await ctx.reply('Эта команда доступна только владельцу бота в личных сообщениях.');
        return;
      }
      try {
        const result = await runBackup({ db: options.db, channel, log: warn });
        await ctx.reply(`Готово: ${result.filename}, строк ${result.encoded.rowCount}.`);
      } catch (error) {
        await ctx.reply(
          `Не удалось снять копию: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });

    stopBackup = startBackupScheduler({
      db: options.db,
      channel,
      intervalMs: options.backup.intervalMs,
      log: warn,
    });
  }

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
    stopBackup?.();
    stopAnnouncements();
    if (bot.isRunning()) await bot.stop();
    throw error;
  }

  return {
    bot,
    async stop() {
      stopBackup?.();
      stopAnnouncements();
      if (bot.isRunning()) await bot.stop();
    },
  };
}
