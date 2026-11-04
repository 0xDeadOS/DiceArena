import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import {
  createDatabase,
  PrismaGameRepository,
  PrismaProfileRepository,
  PrismaRoomRepository,
} from '../src/index.js';
export async function databaseHarness() {
  const rawUrl = process.env.TEST_DATABASE_URL;
  if (!rawUrl) throw new Error('Set TEST_DATABASE_URL to a separate PostgreSQL test database.');
  const url = new URL(rawUrl);
  if (!url.pathname.endsWith('_test'))
    throw new Error(
      'Integration database name must end in _test. Production databases are never used.',
    );
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  url.searchParams.set('schema', schema);
  const admin = new pg.Client({ connectionString: rawUrl });
  const db = createDatabase(url.toString());
  await admin.connect();
  try {
    await admin.query(`CREATE SCHEMA "${schema}"`);
    await admin.query(`SET search_path TO "${schema}"`);
    const root = new URL('../prisma/migrations/', import.meta.url);
    const migrations = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const directory of migrations)
      await admin.query(await readFile(new URL(`${directory}/migration.sql`, root), 'utf8'));
    await db.$connect();
  } catch (error) {
    await admin.query('ROLLBACK');
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await db.$disconnect();
    await admin.end();
    throw error;
  }
  return {
    db,
    admin,
    url: url.toString(),
    profiles: new PrismaProfileRepository(db),
    rooms: new PrismaRoomRepository(db),
    game: new PrismaGameRepository(db),
    reset: async () => {
      await admin.query('TRUNCATE TABLE "Room", "User" CASCADE');
    },
    close: async () => {
      await db.$disconnect();
      try {
        await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await admin.end();
      }
    },
  };
}
export type DatabaseHarness = Awaited<ReturnType<typeof databaseHarness>>;
