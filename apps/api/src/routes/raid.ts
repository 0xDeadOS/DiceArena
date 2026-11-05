import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { RaidCommand, RaidRepository } from '@dicebound/db';
import type { LeaderboardDTO, RaidDTO } from '@dicebound/shared-types';
import type { MembershipChecker } from '../auth/membership.js';
import { resolveRoom } from '../services/context.js';
import { AppError } from '../errors.js';

const empty = { type: 'object', properties: {}, additionalProperties: false } as const;
const revision = { type: 'integer', minimum: 0, maximum: 2_147_483_646 } as const;
const confirmed = { type: 'boolean', const: true } as const;

export function raidRoutes(
  app: FastifyInstance,
  deps: {
    raid: RaidRepository;
    membership: MembershipChecker;
    profiles: import('@dicebound/db').ProfileRepository;
    clock: () => Date;
    hooks: onRequestHookHandler[];
  },
) {
  const context = async (request: FastifyRequest) => {
    if (!request.launch)
      throw new AppError(401, 'INVALID_INIT_DATA', 'Требуется вход через Telegram.');
    return {
      room: await resolveRoom(request.launch, deps.profiles, deps.membership),
      identity: request.launch.user,
    };
  };
  app.get<{ Reply: RaidDTO }>(
    '/api/raid',
    { onRequest: deps.hooks, schema: { querystring: empty } },
    async (request) => {
      const { room, identity } = await context(request);
      return deps.raid.current(room, identity, deps.clock());
    },
  );
  app.get<{ Reply: LeaderboardDTO }>(
    '/api/leaderboard',
    { onRequest: deps.hooks, schema: { querystring: empty } },
    async (request) => {
      const { room, identity } = await context(request);
      return deps.raid.leaderboard(room, identity, deps.clock());
    },
  );
  const routes = [
    {
      path: '/api/raid/contribute',
      type: 'CONTRIBUTE',
      properties: {
        fragments: { type: 'integer', minimum: 1, maximum: 15 },
        expectedRevision: revision,
        confirmed,
      },
    },
    {
      path: '/api/raid/summon',
      type: 'SUMMON',
      properties: { expectedRevision: revision, confirmed },
    },
    {
      path: '/api/raid/attack',
      type: 'ATTACK',
      properties: { raidId: { type: 'string', format: 'uuid' }, expectedRevision: revision },
    },
    {
      path: '/api/raid/decide',
      type: 'DECIDE',
      properties: {
        raidId: { type: 'string', format: 'uuid' },
        attackId: { type: 'string', format: 'uuid' },
        expectedRevision: revision,
        action: { type: 'string', enum: ['DIRECT', 'SHIFT', 'REROLL'] },
      },
    },
    {
      path: '/api/raid/claim-trophy',
      type: 'CLAIM_TROPHY',
      properties: {
        raidId: { type: 'string', format: 'uuid' },
        expectedRevision: revision,
        confirmed,
      },
    },
  ] as const;
  for (const { path, type, properties } of routes)
    app.post<{ Body: Record<string, unknown>; Reply: RaidDTO }>(
      path,
      {
        onRequest: deps.hooks,
        schema: {
          querystring: empty,
          body: {
            type: 'object',
            properties,
            required: Object.keys(properties),
            additionalProperties: false,
          },
          headers: {
            type: 'object',
            required: ['idempotency-key'],
            properties: {
              'idempotency-key': {
                type: 'string',
                pattern:
                  '^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-4[a-fA-F0-9]{3}-[89aAbB][a-fA-F0-9]{3}-[a-fA-F0-9]{12}$',
              },
            },
          },
        },
      },
      async (request) => {
        const { room, identity } = await context(request);
        return deps.raid.execute(
          room,
          identity,
          { ...request.body, type } as RaidCommand,
          request.headers['idempotency-key'] as string,
          deps.clock(),
        );
      },
    );
}
