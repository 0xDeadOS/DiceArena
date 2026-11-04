import { z } from 'zod';

const schema = z.object({
  BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
  DATABASE_URL: z
    .string()
    .url()
    .refine((value) => /^postgres(ql)?:\/\//.test(value)),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
});
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return result.data;
}
