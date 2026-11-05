import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { InventoryResponse } from '@dicebound/shared-types';
import { GameRuleError } from '@dicebound/game-core';
import { buildApp } from '../app.js';
import { AppError } from '../errors.js';
import { fixtureHub, NOW, ROOM, signedInitData, TEST_TOKEN } from '../../../../tests/fixtures.js';
import { fixtureInventory } from '../../../../tests/inventory-fixtures.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
const id = fixtureHub().inventory.dice[0]!.id;
const auth = () => ({ authorization: `tma ${signedInitData()}`, 'idempotency-key': randomUUID() });
async function setup() {
  const profiles = {
    findRoom: vi.fn(async () => ROOM),
    openSession: vi.fn(async () => fixtureHub()),
    loadHub: vi.fn(async () => fixtureHub()),
    isReady: vi.fn(async () => true),
  };
  const membership = { assertMember: vi.fn(async () => undefined) };
  const inventory = {
    current: vi.fn(async () => fixtureInventory()),
    execute: vi.fn(async (): Promise<InventoryResponse> => ({
      inventory: fixtureInventory(),
      result: { type: 'EQUIP', dieId: id },
    })),
  };
  const app = await buildApp({
    profiles,
    membership,
    inventory,
    botToken: TEST_TOKEN,
    clock: () => NOW,
    logLevel: false,
  });
  apps.push(app);
  return { app, inventory, membership };
}
describe('inventory and crafting HTTP boundary', () => {
  it('returns server policies only for the signed member and room', async () => {
    const { app, inventory } = await setup();
    const response = await app.inject({ url: '/api/inventory', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fixtureInventory());
    expect(inventory.current).toHaveBeenCalledWith(
      ROOM,
      { id: 42, firstName: 'Алиса', username: 'alice' },
      NOW,
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it.each([
    ['/api/tutorial/reward', { expectedRevision: 0, confirmed: true }, 'TUTORIAL_REWARD'],
    ['/api/tutorial/complete', { expectedRevision: 0, confirmed: true }, 'TUTORIAL_COMPLETE'],
    [
      '/api/inventory/claim',
      { dropId: id, expectedRevision: 0, action: 'TAKE', confirmed: true },
      'CLAIM_DROP',
    ],
    ['/api/inventory/equip', { dieId: id, expectedRevision: 0 }, 'EQUIP'],
    ['/api/inventory/lock', { dieId: id, expectedRevision: 0, locked: true }, 'LOCK'],
    ['/api/inventory/dismantle', { dieId: id, expectedRevision: 0, confirmed: true }, 'DISMANTLE'],
    [
      '/api/workshop/craft',
      { dieId: id, expectedRevision: 0, sphere: 'CASTING', confirmed: true },
      'CRAFT',
    ],
  ])('validates and authorizes %s', async (url, payload, type) => {
    const { app, inventory, membership } = await setup();
    const headers = auth();
    expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(200);
    expect(membership.assertMember).toHaveBeenCalledWith(ROOM.telegramChatId, 42);
    expect(inventory.execute).toHaveBeenCalledWith(
      ROOM,
      { id: 42, firstName: 'Алиса', username: 'alice' },
      { ...payload, type },
      headers['idempotency-key'],
      NOW,
    );
  });
  it.each([
    { userId: 42 },
    { chatId: -100 },
    { seed: 'known' },
    { face: 6 },
    { affixes: [] },
    { quality: 20 },
    { cost: 0 },
    { confirmed: false },
    { confirmed: undefined },
    { sphere: 'UNKNOWN' },
    { expectedRevision: '0' },
    { expectedRevision: -1 },
    { expectedRevision: 1.5 },
    { dieId: 'other' },
  ])('rejects client authority or invalid shape %j', async (extra) => {
    const { app, inventory } = await setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/workshop/craft',
          headers: auth(),
          payload: {
            dieId: id,
            expectedRevision: 0,
            sphere: 'FACETING',
            confirmed: true,
            ...extra,
          },
        })
      ).statusCode,
    ).toBe(400);
    expect(inventory.execute).not.toHaveBeenCalled();
  });
  it('requires UUIDv4 keys and explicit dismantle consent', async () => {
    const { app, inventory } = await setup();
    for (const key of [undefined, 'not-a-uuid', '10000000-0000-1000-8000-000000000001'])
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/inventory/equip',
            headers: {
              authorization: auth().authorization,
              ...(key ? { 'idempotency-key': key } : {}),
            },
            payload: { dieId: id, expectedRevision: 0 },
          })
        ).statusCode,
      ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/inventory/dismantle',
          headers: auth(),
          payload: { dieId: id, expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(400);
    expect(inventory.execute).not.toHaveBeenCalled();
  });
  it('requires Telegram auth, valid membership and no query identity override', async () => {
    const { app, inventory, membership } = await setup();
    expect((await app.inject('/api/inventory')).statusCode).toBe(401);
    expect(
      (await app.inject({ url: '/api/inventory?userId=42', headers: auth() })).statusCode,
    ).toBe(400);
    membership.assertMember.mockRejectedValue(
      new AppError(403, 'NOT_A_ROOM_MEMBER', 'Нет доступа.'),
    );
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/inventory/equip',
          headers: auth(),
          payload: { dieId: id, expectedRevision: 0 },
        })
      ).statusCode,
    ).toBe(403);
    expect(inventory.current).not.toHaveBeenCalled();
    expect(inventory.execute).not.toHaveBeenCalled();
  });
  it('shares user rate limiting with the hub and surfaces safe conflicts/errors', async () => {
    const { app, inventory } = await setup();
    inventory.execute
      .mockRejectedValueOnce(new GameRuleError('SPHERE_MISSING', 'Нет сферы.'))
      .mockRejectedValueOnce(new Error('craftSeed secret'));
    const request = {
      method: 'POST' as const,
      url: '/api/inventory/equip',
      headers: auth(),
      payload: { dieId: id, expectedRevision: 0 },
    };
    const missing = await app.inject(request);
    expect(missing.statusCode).toBe(409);
    expect(missing.json().error.code).toBe('SPHERE_MISSING');
    const failure = await app.inject(request);
    expect(failure.statusCode).toBe(500);
    expect(failure.body).not.toContain('craftSeed');
    for (let i = 0; i < 3; i++)
      expect((await app.inject({ url: '/api/hub', headers: auth() })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/inventory', headers: auth() })).statusCode).toBe(429);
  });
  it.each([
    ['/api/tutorial/reward', { expectedRevision: 0, confirmed: false }],
    ['/api/tutorial/reward', { expectedRevision: 0, confirmed: true, amount: 100 }],
    ['/api/tutorial/complete', { expectedRevision: 0, confirmed: true, tutorialDone: true }],
    ['/api/inventory/claim', { dropId: id, expectedRevision: 0, action: 'TAKE' }],
    [
      '/api/inventory/claim',
      { dropId: id, expectedRevision: 0, action: 'DISCARD', confirmed: true },
    ],
    [
      '/api/inventory/claim',
      {
        dropId: id,
        expectedRevision: 0,
        action: 'TAKE',
        confirmed: true,
        die: { powerScore: 9999 },
      },
    ],
  ])('rejects forged progression or claim bodies at %s', async (url, payload) => {
    const { app, inventory } = await setup();
    expect((await app.inject({ method: 'POST', url, headers: auth(), payload })).statusCode).toBe(
      400,
    );
    expect(inventory.execute).not.toHaveBeenCalled();
  });
});
