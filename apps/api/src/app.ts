import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { GameRuleError } from '@dicebound/game-core';
import { gameRoutes } from './routes/game.js';
import { inventoryRoutes } from './routes/inventory.js';
import { raidRoutes } from './routes/raid.js';
import type {
  GameRepository,
  InventoryRepository,
  ProfileRepository,
  RaidRepository,
} from '@dicebound/db';
import type { ApiErrorDTO, HubDTO, SessionDTO } from '@dicebound/shared-types';
import { verifyAuthorization } from './auth/init-data.js';
import type { VerifiedLaunch } from './auth/init-data.js';
import type { MembershipChecker } from './auth/membership.js';
import { resolveRoom } from './services/context.js';
import { AppError } from './errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    launch: VerifiedLaunch | null;
  }
}

export interface AppDependencies {
  profiles: ProfileRepository;
  game?: GameRepository;
  inventory?: InventoryRepository;
  raid?: RaidRepository;
  membership: MembershipChecker;
  botToken: string;
  maxInitDataAgeSeconds?: number;
  clock?: () => Date;
  logLevel?: string | false;
  /**
   * Происхождения, которым разрешено вызывать API из браузера.
   *
   * Нужно, когда фронтенд отдан отдельным статическим сайтом (например Static
   * Site на Render) и браузер обращается к API на другом домене. Пусто или
   * отсутствует — CORS не включается, API доступен только с того же
   * происхождения.
   */
  corsOrigins?: string[];
  /**
   * Доверять заголовкам `X-Forwarded-*` от обратного прокси.
   *
   * За прокси платформы (Render и подобные) без этого rate-limit по IP видит
   * адрес прокси и считает квоту общей для всех клиентов.
   */
  trustProxy?: boolean;
}

export async function buildApp(deps: AppDependencies) {
  const clock = deps.clock ?? (() => new Date());
  const app = Fastify({
    logger:
      deps.logLevel === false
        ? false
        : {
            level: deps.logLevel ?? 'info',
            redact: ['req.headers.authorization', 'headers.authorization'],
            serializers: {
              req: (req) => ({
                method: req.method,
                url: req.url?.split('?')[0],
                remoteAddress: req.ip,
              }),
            },
          },
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    bodyLimit: 4_096,
    requestTimeout: 10_000,
    connectionTimeout: 10_000,
    trustProxy: deps.trustProxy ?? false,
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
  });
  app.decorateRequest('launch', null);
  app.addHook('onSend', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store').header('X-Content-Type-Options', 'nosniff');
  });
  app.setErrorHandler((error, request, reply) => {
    let status = 500;
    let code = 'INTERNAL_ERROR';
    let message = 'Сервис временно недоступен. Попробуйте позже.';
    if (error instanceof AppError || error instanceof GameRuleError)
      ({ status, code, message } = error);
    else if (error instanceof Error && 'statusCode' in error && error.statusCode === 429) {
      status = 429;
      code = 'RATE_LIMITED';
      message = 'Слишком много запросов. Подождите секунду.';
    } else if (
      error instanceof Error &&
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode >= 400 &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      code = 'BAD_REQUEST';
      message = 'Некорректный запрос.';
    }
    if (status >= 500) {
      // Error messages/ORM parameters may contain secrets; log only safe metadata.
      request.log.error(
        { errorName: error instanceof Error ? error.name : 'Unknown', code },
        'Request failed',
      );
    }
    const body: ApiErrorDTO = { error: { code, message, requestId: request.id } };
    void reply.code(status).send(body);
  });
  app.setNotFoundHandler((request, reply) => {
    void reply
      .code(404)
      .send({ error: { code: 'NOT_FOUND', message: 'Маршрут не найден.', requestId: request.id } });
  });

  if (deps.corsOrigins && deps.corsOrigins.length > 0) {
    // Явный белый список: `credentials` не используется, авторизация идёт в
    // заголовке `Authorization: tma <initData>`, поэтому достаточно origin+headers.
    await app.register(cors, {
      origin: deps.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type', 'Idempotency-Key'],
      credentials: false,
      maxAge: 600,
    });
  }

  // Coarse IP protection before HMAC; user quota uses the signed identity, not a header/user_id.
  await app.register(rateLimit, { global: true, max: 30, timeWindow: 1_000, skipOnError: false });
  const userLimit = app.rateLimit({
    max: 5,
    timeWindow: 1_000,
    keyGenerator: (request) => `tg:${request.launch?.user.id ?? 'anonymous'}`,
  });
  const signedLaunch = async (request: import('fastify').FastifyRequest) => {
    request.launch = verifyAuthorization(
      request.headers.authorization,
      deps.botToken,
      clock(),
      deps.maxInitDataAgeSeconds ?? 86_400,
    );
  };
  const requireLaunch = (request: import('fastify').FastifyRequest): VerifiedLaunch => {
    if (!request.launch)
      throw new AppError(401, 'INVALID_INIT_DATA', 'Требуется вход через Telegram.');
    return request.launch;
  };
  const emptyObject = { type: 'object', properties: {}, additionalProperties: false } as const;

  app.get('/health/live', { config: { rateLimit: false } }, async () => ({ status: 'ok' }));
  app.get('/health/ready', async (_request, reply) => {
    try {
      if (await deps.profiles.isReady()) return { status: 'ready' };
    } catch {
      /* Deliberately do not return connection strings/driver messages. */
    }
    return reply.code(503).send({ status: 'unavailable' });
  });

  app.post<{ Reply: SessionDTO }>(
    '/api/auth/session',
    {
      onRequest: [signedLaunch, userLimit],
      schema: { body: emptyObject, querystring: emptyObject },
    },
    async (request) => {
      const launch = requireLaunch(request);
      const room = await resolveRoom(launch, deps.profiles, deps.membership);
      const hub = await deps.profiles.openSession(room, launch.user, clock());
      return { hub, authExpiresAt: launch.expiresAt.toISOString() };
    },
  );

  app.get<{ Reply: HubDTO }>(
    '/api/hub',
    {
      onRequest: [signedLaunch, userLimit],
      schema: { querystring: emptyObject },
    },
    async (request) => {
      const launch = requireLaunch(request);
      const room = await resolveRoom(launch, deps.profiles, deps.membership);
      const hub = await deps.profiles.loadHub(room, launch.user, clock());
      if (!hub) throw new AppError(409, 'SESSION_REQUIRED', 'Сначала откройте игровую сессию.');
      return hub;
    },
  );
  if (deps.game)
    gameRoutes(app, {
      game: deps.game,
      profiles: deps.profiles,
      membership: deps.membership,
      clock,
      hooks: [signedLaunch, userLimit],
    });
  if (deps.inventory)
    inventoryRoutes(app, {
      inventory: deps.inventory,
      profiles: deps.profiles,
      membership: deps.membership,
      clock,
      hooks: [signedLaunch, userLimit],
    });
  if (deps.raid)
    raidRoutes(app, {
      raid: deps.raid,
      profiles: deps.profiles,
      membership: deps.membership,
      clock,
      hooks: [signedLaunch, userLimit],
    });
  return app;
}
