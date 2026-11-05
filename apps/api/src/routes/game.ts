import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { GameRepository, ProfileRepository, GameCommand } from '@dicebound/db';
import type { RunResponse } from '@dicebound/shared-types';
import type { MembershipChecker } from '../auth/membership.js';
import { resolveRoom } from '../services/context.js';
import { AppError } from '../errors.js';

const uuid = { type: 'string', format: 'uuid' } as const;
const revision = { type: 'integer', minimum: 0, maximum: 2_147_483_646 } as const;
const empty = { type: 'object', properties: {}, additionalProperties: false } as const;
export function gameRoutes(
  app: FastifyInstance,
  deps: {
    game: GameRepository;
    profiles: ProfileRepository;
    membership: MembershipChecker;
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
  app.get<{ Reply: RunResponse }>(
    '/api/map/current',
    { onRequest: deps.hooks, schema: { querystring: empty } },
    async (request) => {
      const { room, identity } = await context(request);
      return { run: await deps.game.current(room, identity) };
    },
  );
  const definitions = [
    { path: '/api/map/start', type: 'START', properties: {} },
    {
      path: '/api/expedition/start',
      type: 'EXPEDITION',
      properties: {
        level: { type: 'integer', minimum: 1, maximum: 50 },
        expectedInventoryRevision: revision,
        confirmed: { type: 'boolean', const: true },
      },
    },
    {
      path: '/api/map/step',
      type: 'STEP',
      properties: {
        runId: uuid,
        expectedRevision: revision,
        nodeId: { type: 'string', pattern: '^f[1-7]-[01]$' },
      },
    },
    {
      path: '/api/map/retreat',
      type: 'RETREAT',
      properties: { runId: uuid, expectedRevision: revision },
    },
    {
      path: '/api/battle/roll',
      type: 'ROLL',
      properties: { runId: uuid, expectedRevision: revision, battleId: uuid },
    },
    {
      path: '/api/battle/decision',
      type: 'DECISION',
      properties: {
        runId: uuid,
        expectedRevision: revision,
        battleId: uuid,
        action: { type: 'string', enum: ['DIRECT', 'SHIFT', 'FLIP', 'REROLL'] },
      },
    },
  ] as const;
  for (const { path, type, properties } of definitions) {
    app.post<{ Body: Record<string, unknown>; Reply: RunResponse }>(
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
        // All body keys/types are validated by Fastify; type cannot come from the client.
        const command = { ...request.body, type } as GameCommand;
        return {
          run: await deps.game.execute(
            room,
            identity,
            command,
            request.headers['idempotency-key'] as string,
            deps.clock(),
          ),
        };
      },
    );
  }
}
