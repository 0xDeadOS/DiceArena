import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { Api } from 'grammy';
import { createDatabase, PrismaProfileRepository, PrismaGameRepository } from '@dicebound/db';
import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { TelegramMembershipChecker } from './auth/membership.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

async function main() {
  const config = readConfig();
  const db = createDatabase(config.DATABASE_URL);
  const telegram = new Api(config.BOT_TOKEN, { timeoutSeconds: 5 });
  const membership = new TelegramMembershipChecker({
    fetchMember: (chatId, userId) => telegram.getChatMember(chatId.toString(), userId),
  });
  const app = await buildApp({
    botToken: config.BOT_TOKEN,
    profiles: new PrismaProfileRepository(db),
    game: new PrismaGameRepository(db),
    membership,
    maxInitDataAgeSeconds: config.INIT_DATA_MAX_AGE_SECONDS,
    logLevel: config.LOG_LEVEL,
  });
  app.addHook('onClose', async () => {
    await db.$disconnect();
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close();
    });
  }
  try {
    await db.$connect();
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch (error) {
    await app.close();
    throw error;
  }
}
void main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.startsWith('Invalid environment:')
      ? error.message
      : 'API startup failed. Check PostgreSQL, migrations and environment configuration.';
  console.error(message);
  process.exitCode = 1;
});
