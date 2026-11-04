import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'packages/db/prisma/schema.prisma',
  migrations: { path: 'packages/db/prisma/migrations' },
  // Generate/validate work without secrets; migrate requires DATABASE_URL.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
