import { z } from 'zod';

const schema = z
  .object({
    BOT_TOKEN: z.string().regex(/^\d+:[A-Za-z0-9_-]{20,}$/),
    DATABASE_URL: z
      .string()
      .url()
      .refine((value) => /^postgres(ql)?:\/\//.test(value)),
    HOST: z.string().default('0.0.0.0'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3001),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    INIT_DATA_MAX_AGE_SECONDS: z.coerce.number().int().min(60).max(86_400).default(86_400),
    /**
     * Поднимать ли Telegram-бота внутри процесса API.
     *
     * Платформы без бесплатных background-воркеров (например Render) требуют
     * держать поллинг-бота в том же web-сервисе, что и HTTP: иначе инстанс
     * простаивает и засыпает. Отдельный воркер задаёт `RUN_BOT=false`.
     */
    RUN_BOT: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
    /** Короткое имя Mini App из BotFather; обязательно, когда бот включён. */
    APP_SHORT_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_]{3,64}$/)
      .optional(),
    /**
     * Список происхождений фронтенда через запятую, которым разрешён CORS.
     *
     * Задаётся, когда статика отдана отдельным сайтом и браузер обращается к API
     * на другом домене. Пример: `https://dicebound.onrender.com`.
     */
    CORS_ORIGINS: z.string().optional(),
    /**
     * Доверять `X-Forwarded-*` от обратного прокси платформы.
     *
     * За прокси без этого rate-limit по IP видит адрес прокси и считает квоту
     * общей для всех клиентов.
     */
    TRUST_PROXY: z
      .enum(['true', 'false', '1', '0'])
      .default('false')
      .transform((value) => value === 'true' || value === '1'),
    /**
     * Личные сообщения админа, куда бот присылает резервную копию базы.
     * Пусто — резервное копирование выключено.
     */
    BACKUP_CHAT_ID: z
      .string()
      .regex(/^-?\d+$/)
      .transform((value) => BigInt(value))
      .optional(),
    /** Период резервного копирования в часах. */
    BACKUP_INTERVAL_HOURS: z.coerce.number().min(1).max(168).default(6),
  })
  .superRefine((config, ctx) => {
    if (config.RUN_BOT && !config.APP_SHORT_NAME) {
      ctx.addIssue({
        code: 'custom',
        message: 'APP_SHORT_NAME is required when RUN_BOT is enabled',
        path: ['APP_SHORT_NAME'],
      });
    }
  });
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid environment: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  return result.data;
}
