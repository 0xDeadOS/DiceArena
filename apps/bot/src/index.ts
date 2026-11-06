import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { z } from 'zod';
import { createDatabase, PrismaRoomRepository } from '@dicebound/db';
import { startBotRuntime } from './runtime.js';

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
      BACKUP_CHAT_ID: z
        .string()
        .regex(/^-?\d+$/)
        .transform((value) => BigInt(value))
        .optional(),
      BACKUP_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(6),
    })
    .safeParse(process.env);
  if (!parsed.success)
    throw new Error(
      `Invalid environment: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  const config = parsed.data;
  const db = createDatabase(config.DATABASE_URL);
  let runtime: Awaited<ReturnType<typeof startBotRuntime>> | undefined;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void runtime?.stop();
    });
  }
  try {
    await db.$connect();
    // Тот же runtime, что встраивается в процесс API (apps/api/src/combined.ts).
    runtime = await startBotRuntime({
      botToken: config.BOT_TOKEN,
      appShortName: config.APP_SHORT_NAME,
      rooms: new PrismaRoomRepository(db),
      db,
      backup: config.BACKUP_CHAT_ID
        ? {
            chatId: config.BACKUP_CHAT_ID,
            intervalMs: config.BACKUP_INTERVAL_HOURS * 3_600_000,
          }
        : undefined,
    });
  } finally {
    await runtime?.stop();
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
