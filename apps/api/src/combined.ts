/**
 * Совмещённая точка входа: HTTP API и Telegram-бот в одном процессе.
 *
 * Бесплатные тарифы платформ (в том числе Render) дают бесплатный *web-сервис*,
 * но не дают бесплатного *background-воркера*. Бот на long polling не может жить
 * в бесплатном web-сервисе сам по себе: поллинг не порождает входящих запросов,
 * поэтому инстанс простаивает с момента старта и Render усыпляет его через
 * 15 минут без входящего трафика. Бот рядом с API держит сервис отвечающим на
 * HTTP, и обе части используют один пул соединений с базой.
 *
 * Каждая часть по-прежнему запускается отдельно через свой `index.ts`.
 */
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Api } from 'grammy';
import {
  createDatabase,
  PrismaProfileRepository,
  PrismaGameRepository,
  PrismaInventoryRepository,
  PrismaRaidRepository,
  PrismaRoomRepository,
} from '@dicebound/db';
import { startBotRuntime } from '@dicebound/bot/runtime';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { TelegramMembershipChecker } from './auth/membership.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

async function main() {
  const config = readConfig();
  const db = createDatabase(config.DATABASE_URL);
  const telegram = new Api(config.BOT_TOKEN, { timeoutSeconds: 5 });

  const app = await buildApp({
    botToken: config.BOT_TOKEN,
    profiles: new PrismaProfileRepository(db),
    game: new PrismaGameRepository(db),
    inventory: new PrismaInventoryRepository(db),
    raid: new PrismaRaidRepository(db),
    membership: new TelegramMembershipChecker({
      fetchMember: (chatId, userId) => telegram.getChatMember(chatId.toString(), userId),
    }),
    maxInitDataAgeSeconds: config.INIT_DATA_MAX_AGE_SECONDS,
    logLevel: config.LOG_LEVEL,
    corsOrigins: (config.CORS_ORIGINS ?? '')
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    trustProxy: config.TRUST_PROXY,
  });

  let bot: Awaited<ReturnType<typeof startBotRuntime>> | undefined;
  app.addHook('onClose', async () => {
    if (bot) await bot.stop();
    await db.$disconnect();
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    void app.close();
  };
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, shutdown);

  try {
    await db.$connect();
    // HTTP поднимается первым: платформа проверяет здоровье сервиса по порту,
    // а подключение бота к Telegram может занимать секунды или упасть на
    // настройках BotFather. Если слушать бота раньше, сервис не откроет порт
    // и деплой будет признан непройденным healthcheck'ом.
    await app.listen({ host: config.HOST, port: config.PORT });

    const appShortName = config.APP_SHORT_NAME;
    if (config.RUN_BOT && appShortName) {
      bot = await startBotRuntime({
        botToken: config.BOT_TOKEN,
        appShortName,
        rooms: new PrismaRoomRepository(db),
        db,
        log: {
          info: (message) => app.log.info(message),
          warn: (message) => app.log.warn(message),
        },
      });
    } else {
      // readConfig() уже отклонила RUN_BOT без APP_SHORT_NAME, поэтому сюда
      // попадаем только при явном отключении бота.
      app.log.info('Bot disabled: serving HTTP only.');
    }
  } catch (error) {
    await app.close();
    throw error;
  }
}

void main().catch((error: unknown) => {
  const reason = error instanceof Error ? error.message : String(error);
  const hint = reason.startsWith('Invalid environment:')
    ? ''
    : ' Check PostgreSQL, migrations, BotFather settings and existing webhooks.';
  // Причина обязательна в логе: без неё сбой бота неотличим от сбоя базы.
  console.error(`Combined startup failed: ${reason}.${hint}`);
  process.exitCode = 1;
});
