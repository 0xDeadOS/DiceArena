import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { createDatabase, PrismaRoomRepository } from '@dicebound/db';
import { buildBot } from './bot.js';

loadEnv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

async function main() {
  const parsed = z
    .object({
      BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
      DATABASE_URL: z
        .string()
        .url()
        .refine((value) => /^postgres(ql)?:\/\//.test(value)),
      APP_SHORT_NAME: z.string().regex(/^[A-Za-z0-9_]{3,64}$/),
    })
    .safeParse(process.env);
  if (!parsed.success)
    throw new Error(
      `Invalid environment: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const config = parsed.data;
  const db = createDatabase(config.DATABASE_URL);
  const bot = buildBot(config.BOT_TOKEN, config.APP_SHORT_NAME, new PrismaRoomRepository(db));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      if (bot.isRunning()) void bot.stop();
    });
  }
  try {
    await db.$connect();
    await bot.init();
    // grammY start() deletes webhooks; refuse to take over a configured webhook bot.
    const webhook = await bot.api.getWebhookInfo();
    if (webhook.url) throw new Error('Configured webhook: long polling startup refused');
    await bot.api.setMyCommands([
      { command: 'game', description: 'Войти в Обитель чата' },
      { command: 'start', description: 'Как начать играть' },
      { command: 'help', description: 'Правила и помощь' },
    ]);
    await bot.start({
      allowed_updates: ['message', 'my_chat_member'],
      onStart: () => console.info('Dicebound bot is running.'),
    });
  } finally {
    await db.$disconnect();
  }
}
void main().catch((error: unknown) => {
  const message =
    error instanceof Error && error.message.startsWith('Invalid environment:')
      ? error.message
      : 'Bot startup failed. Check PostgreSQL, BotFather settings, network access and existing webhooks.';
  console.error(message);
  process.exitCode = 1;
});
