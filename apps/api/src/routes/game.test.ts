import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { GameRuleError } from '@dicebound/game-core';
import { buildApp } from '../app.js';
import { AppError } from '../errors.js';
import { fixtureHub, NOW, ROOM, signedInitData, TEST_TOKEN } from '../../../../tests/fixtures.js';
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});
async function setup() {
  const profiles = {
    findRoom: vi.fn(async () => ROOM),
    openSession: vi.fn(async () => fixtureHub()),
    loadHub: vi.fn(async () => fixtureHub()),
    isReady: vi.fn(async () => true),
  };
  const membership = { assertMember: vi.fn(async () => undefined) };
  const game = {
    current: vi.fn(async () => null),
    execute: vi.fn(async () => ({ id: 'safe-run' }) as never),
  };
  const app = await buildApp({
    profiles,
    membership,
    game,
    botToken: TEST_TOKEN,
    clock: () => NOW,
    logLevel: false,
  });
  apps.push(app);
  return { app, profiles, membership, game };
}
const headers = () => ({
  authorization: `tma ${signedInitData()}`,
  'idempotency-key': randomUUID(),
});
const runId = '10000000-0000-4000-8000-000000000001';
const battleId = '20000000-0000-4000-8000-000000000001';
describe('game HTTP boundary', () => {
  it.each([
    ['/api/map/start', {}, 'START'],
    ['/api/map/step', { runId, nodeId: 'f1-0', expectedRevision: 0 }, 'STEP'],
    ['/api/map/retreat', { runId, expectedRevision: 1 }, 'RETREAT'],
    ['/api/battle/roll', { runId, battleId, expectedRevision: 1 }, 'ROLL'],
    ['/api/battle/decision', { runId, battleId, expectedRevision: 2, action: 'FLIP' }, 'DECISION'],
  ])('resolves signed context and validates %s', async (url, payload, type) => {
    const { app, game, membership } = await setup();
    const auth = headers();
    const result = await app.inject({ method: 'POST', url, headers: auth, payload });
    expect(result.statusCode).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(membership.assertMember).toHaveBeenCalledWith(ROOM.telegramChatId, 42);
    expect(game.execute).toHaveBeenCalledWith(
      ROOM,
      { id: 42, firstName: 'Алиса', username: 'alice' },
      { ...payload, type },
      auth['idempotency-key'],
      NOW,
    );
  });
  it('restores the current run only for the signed context', async () => {
    const { app, game } = await setup();
    const result = await app.inject({ url: '/api/map/current', headers: headers() });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({ run: null });
    expect(game.current).toHaveBeenCalledWith(ROOM, {
      id: 42,
      firstName: 'Алиса',
      username: 'alice',
    });
  });
  it.each([
    ['no idempotency header', {}, null],
    ['client identity', { userId: 42 }, 'valid'],
    ['client RNG', { seed: 'known', face: 6 }, 'valid'],
    ['non UUID key', {}, 'test'],
    ['client mode', { mode: 'NORMAL', hasVigorBoost: true }, 'valid'],
  ])('rejects %s', async (_name, payload, key) => {
    const { app, game } = await setup();
    const auth: Record<string, string> = { authorization: headers().authorization };
    if (key) auth['idempotency-key'] = key === 'valid' ? randomUUID() : key;
    expect(
      (await app.inject({ method: 'POST', url: '/api/map/start', headers: auth, payload }))
        .statusCode,
    ).toBe(400);
    expect(game.execute).not.toHaveBeenCalled();
  });
  it.each([
    { runId, battleId, expectedRevision: 2, action: 'DIRECT', face: 6 },
    { runId, battleId, expectedRevision: 2, action: 'CHEAT' },
    { runId, battleId, expectedRevision: -1, action: 'DIRECT' },
    { runId, battleId, expectedRevision: 1.5, action: 'DIRECT' },
    { runId, battleId, action: 'DIRECT' },
    { runId: 'other', battleId, expectedRevision: 0, action: 'DIRECT' },
  ])('rejects invalid decision payload %j', async (payload) => {
    const { app, game } = await setup();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/battle/decision',
          headers: headers(),
          payload,
        })
      ).statusCode,
    ).toBe(400);
    expect(game.execute).not.toHaveBeenCalled();
  });
  it('requires valid auth and membership for reads and writes', async () => {
    const { app, game, membership } = await setup();
    expect((await app.inject('/api/map/current')).statusCode).toBe(401);
    membership.assertMember.mockRejectedValue(
      new AppError(403, 'NOT_A_ROOM_MEMBER', 'Нет доступа.'),
    );
    for (const method of ['GET', 'POST'] as const)
      expect(
        (
          await app.inject({
            method,
            url: method === 'GET' ? '/api/map/current' : '/api/map/start',
            headers: headers(),
            ...(method === 'POST' ? { payload: {} } : {}),
          })
        ).statusCode,
      ).toBe(403);
    expect(game.current).not.toHaveBeenCalled();
    expect(game.execute).not.toHaveBeenCalled();
  });
  it('rejects query-string identity overrides', async () => {
    const { app, game } = await setup();
    expect(
      (await app.inject({ url: '/api/map/current?roomId=other', headers: headers() })).statusCode,
    ).toBe(400);
    expect(game.current).not.toHaveBeenCalled();
  });
  it('maps rule conflicts to safe 409 responses and hides unexpected internals', async () => {
    const { app, game } = await setup();
    game.execute
      .mockRejectedValueOnce(new GameRuleError('STALE_STATE', 'Обновите поход.'))
      .mockRejectedValueOnce(new Error('battleSeed secret'));
    const stale = await app.inject({
      method: 'POST',
      url: '/api/map/start',
      headers: headers(),
      payload: {},
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('STALE_STATE');
    const broken = await app.inject({
      method: 'POST',
      url: '/api/map/start',
      headers: headers(),
      payload: {},
    });
    expect(broken.statusCode).toBe(500);
    expect(broken.body).not.toContain('battleSeed');
  });
  it('shares the five-per-second user limit across hub and gameplay', async () => {
    const { app, game } = await setup();
    for (let i = 0; i < 5; i++)
      expect(
        (await app.inject({ url: i % 2 ? '/api/hub' : '/api/map/current', headers: headers() }))
          .statusCode,
      ).toBe(200);
    expect(
      (await app.inject({ method: 'POST', url: '/api/map/start', headers: headers(), payload: {} }))
        .statusCode,
    ).toBe(429);
    expect(game.execute).not.toHaveBeenCalled();
  });
});
