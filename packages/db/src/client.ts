import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from './generated/prisma/client.js';

export function createDatabase(databaseUrl: string): PrismaClient {
  const url = new URL(databaseUrl);
  if (!['postgresql:', 'postgres:'].includes(url.protocol))
    throw new Error('PostgreSQL URL required');
  const schema = url.searchParams.get('schema') ?? 'public';
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) throw new Error('Invalid database schema');
  const adapter = new PrismaPg(
    {
      connectionString: databaseUrl,
      max: 10,
      connectionTimeoutMillis: 5_000,
      options: `-c search_path=${schema}`,
    },
    { schema },
  );
  return new PrismaClient({
    adapter,
    transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  });
}
