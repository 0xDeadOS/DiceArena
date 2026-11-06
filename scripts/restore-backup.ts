/**
 * Восстановление базы из резервной копии, присланной ботом в личные сообщения.
 *
 * Заменяет всё содержимое базы, поэтому требует явного подтверждения.
 * Намеренно не является HTTP-эндпоинтом: полная перезапись по запросу из
 * интернета была бы дырой, а не функцией.
 *
 * Использование:
 *   npm run build:server
 *   DATABASE_URL=postgresql://... npm run db:restore -- <файл> --yes
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { createDatabase, decodeBackup, restoreBackup } from '@dicebound/db';

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const confirmed = args.includes('--yes');
  const file = args.find((argument) => !argument.startsWith('--'));

  if (!file)
    fail(
      'Укажите файл резервной копии.\n' +
        'Пример: npm run db:restore -- dicebound-backup-2026-11-06T12-00-00Z.json.gz --yes',
    );

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('DATABASE_URL не задан.');
  if (!/^postgres(ql)?:\/\//.test(databaseUrl))
    fail('DATABASE_URL должен быть адресом PostgreSQL.');

  // Восстановление невозможно без собранного клиента Prisma.
  const bytes = await readFile(file).catch(() => fail(`Не удалось прочитать файл: ${file}`));

  const payload = decodeBackup(new Uint8Array(bytes));
  const rows = Object.entries(payload.tables)
    .map(([table, list]) => `${table}: ${list.length}`)
    .join(', ');

  console.log(`Снимок от ${payload.createdAt}`);
  console.log(`Строк: ${payload.rowCount} (${rows})`);
  console.log(`Цель: ${databaseUrl.replace(/\/\/[^@]*@/, '//***@')}`);

  if (!confirmed) {
    console.error(
      '\nВосстановление заменит всё содержимое базы этим снимком.\n' +
        'Повторите команду с флагом --yes, чтобы подтвердить.',
    );
    process.exitCode = 1;
    return;
  }

  const db = createDatabase(databaseUrl);
  try {
    await db.$connect();
    await restoreBackup(db, payload);
    console.log('База восстановлена из снимка.');
  } finally {
    await db.$disconnect();
  }
}

void main().catch((error: unknown) => {
  fail(`Восстановление не выполнено: ${error instanceof Error ? error.message : String(error)}`);
});
