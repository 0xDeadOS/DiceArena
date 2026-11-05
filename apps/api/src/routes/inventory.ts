import type { FastifyInstance, FastifyRequest, onRequestHookHandler } from 'fastify';
import type { InventoryCommand, InventoryRepository, ProfileRepository } from '@dicebound/db';
import { SPHERE_TYPES } from '@dicebound/shared-types';
import type { InventoryDTO, InventoryResponse } from '@dicebound/shared-types';
import type { MembershipChecker } from '../auth/membership.js';
import { resolveRoom } from '../services/context.js';
import { AppError } from '../errors.js';
const empty = { type: 'object', properties: {}, additionalProperties: false } as const;
const item = {
  dieId: { type: 'string', format: 'uuid' },
  expectedRevision: { type: 'integer', minimum: 0, maximum: 2_147_483_646 },
} as const;
const confirmed = { type: 'boolean', const: true } as const;
export function inventoryRoutes(
  app: FastifyInstance,
  deps: {
    inventory: InventoryRepository;
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
  app.get<{ Reply: InventoryDTO }>(
    '/api/inventory',
    { onRequest: deps.hooks, schema: { querystring: empty } },
    async (request) => {
      const { room, identity } = await context(request);
      return deps.inventory.current(room, identity, deps.clock());
    },
  );
  const routes = [
    { path: '/api/inventory/equip', type: 'EQUIP', properties: { ...item } },
    {
      path: '/api/inventory/lock',
      type: 'LOCK',
      properties: { ...item, locked: { type: 'boolean' } },
    },
    { path: '/api/inventory/dismantle', type: 'DISMANTLE', properties: { ...item, confirmed } },
    {
      path: '/api/workshop/craft',
      type: 'CRAFT',
      properties: { ...item, sphere: { type: 'string', enum: [...SPHERE_TYPES] }, confirmed },
    },
  ] as const;
  for (const { path, type, properties } of routes)
    app.post<{ Body: Record<string, unknown>; Reply: InventoryResponse }>(
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
        return deps.inventory.execute(
          room,
          identity,
          { ...request.body, type } as InventoryCommand,
          request.headers['idempotency-key'] as string,
          deps.clock(),
        );
      },
    );
}
