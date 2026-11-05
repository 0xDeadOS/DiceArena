import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LeaderboardDTO, RaidDTO } from '@dicebound/shared-types';
import { GameRuleError } from '@dicebound/game-core';
import { buildApp } from '../app.js';
import {
  fixtureHub,
  fixtureLeaderboard,
  fixtureRaid,
  NOW,
  ROOM,
  signedInitData,
  TEST_TOKEN,
} from '../../../../tests/fixtures.js';

const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const raidId = fixtureRaid().raid!.id;
const attackId = fixtureRaid().raid!.attack!.id;
const auth = () => ({
  authorization: `tma ${signedInitData()}`,
  'idempotency-key': randomUUID(),
});

async function setup() {
  const profiles = {
    findRoom: vi.fn(async () => ROOM),
    openSession: vi.fn(async () => fixtureHub()),
    loadHub: vi.fn(async () => fixtureHub()),
    isReady: vi.fn(async () => true),
  };
  const membership = { assertMember: vi.fn(async () => undefined) };
  const raid = {
    current: vi.fn(async (): Promise<RaidDTO> => fixtureRaid()),
    leaderboard: vi.fn(async (): Promise<LeaderboardDTO> => fixtureLeaderboard()),
    execute: vi.fn(async (): Promise<RaidDTO> => fixtureRaid()),
  };
  const app = await buildApp({
    profiles,
    membership,
    raid,
    botToken: TEST_TOKEN,
    clock: () => NOW,
    logLevel: false,
  });
  apps.push(app);
  return { app, raid, membership };
}

describe('Рейд Обители на границе HTTP', () => {
  it('отдаёт состояние рейда только подписанному участнику Обители', async () => {
    const { app, raid, membership } = await setup();
    const response = await app.inject({ url: '/api/raid', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fixtureRaid());
    expect(response.headers['cache-control']).toBe('no-store');
    expect(membership.assertMember).toHaveBeenCalled();
    expect(raid.current).toHaveBeenCalledWith(
      ROOM,
      { id: 42, firstName: 'Алиса', username: 'alice' },
      NOW,
    );
  });

  it('отдаёт зал славы Обители', async () => {
    const { app, raid } = await setup();
    const response = await app.inject({ url: '/api/leaderboard', headers: auth() });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fixtureLeaderboard());
    expect(raid.leaderboard).toHaveBeenCalled();
  });

  it('не пускает без подписанного init_data', async () => {
    const { app } = await setup();
    const response = await app.inject({ url: '/api/raid' });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('INVALID_INIT_DATA');
  });

  it.each([
    [
      '/api/raid/contribute',
      { fragments: 3, expectedRevision: 0, confirmed: true },
      { fragments: 3, expectedRevision: 0, confirmed: true, type: 'CONTRIBUTE' },
    ],
    [
      '/api/raid/summon',
      { expectedRevision: 0, confirmed: true },
      { expectedRevision: 0, confirmed: true, type: 'SUMMON' },
    ],
    [
      '/api/raid/attack',
      { raidId, expectedRevision: 4 },
      { raidId, expectedRevision: 4, type: 'ATTACK' },
    ],
    [
      '/api/raid/decide',
      { raidId, attackId, expectedRevision: 4, action: 'DIRECT' },
      { raidId, attackId, expectedRevision: 4, action: 'DIRECT', type: 'DECIDE' },
    ],
    [
      '/api/raid/claim-trophy',
      { raidId, expectedRevision: 4, confirmed: true },
      { raidId, expectedRevision: 4, confirmed: true, type: 'CLAIM_TROPHY' },
    ],
  ])('принимает %s и передаёт команду в хранилище', async (path, body, command) => {
    const { app, raid } = await setup();
    const key = randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `tma ${signedInitData()}`, 'idempotency-key': key },
      payload: body,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(fixtureRaid());
    expect(raid.execute).toHaveBeenCalledWith(
      ROOM,
      expect.objectContaining({ id: 42 }),
      command,
      key,
      NOW,
    );
  });

  it.each([
    ['/api/raid/contribute', { fragments: 0, expectedRevision: 0, confirmed: true }],
    ['/api/raid/contribute', { fragments: 1, expectedRevision: -1, confirmed: true }],
    ['/api/raid/contribute', { fragments: 1, expectedRevision: 0, confirmed: false }],
    ['/api/raid/contribute', { fragments: 1.5, expectedRevision: 0, confirmed: true }],
    ['/api/raid/summon', { expectedRevision: 0 }],
    ['/api/raid/attack', { raidId: 'не-uuid', expectedRevision: 0 }],
    ['/api/raid/attack', { expectedRevision: 0 }],
    ['/api/raid/decide', { raidId, attackId, expectedRevision: 0, action: 'FLIP' }],
    ['/api/raid/decide', { raidId, attackId, expectedRevision: 0 }],
    ['/api/raid/decide', { raidId, attackId, expectedRevision: 0, action: 'DIRECT', extra: 1 }],
    ['/api/raid/claim-trophy', { raidId, expectedRevision: 0 }],
    ['/api/raid/claim-trophy', { raidId: 'не-uuid', expectedRevision: 0, confirmed: true }],
    ['/api/raid/claim-trophy', { raidId, expectedRevision: 0, confirmed: false }],
  ])('отклоняет невалидное тело %s', async (path, body) => {
    const { app, raid } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: path,
      headers: { authorization: `tma ${signedInitData()}`, 'idempotency-key': randomUUID() },
      payload: body,
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('BAD_REQUEST');
    expect(raid.execute).not.toHaveBeenCalled();
  });

  it('требует UUIDv4 в заголовке идемпотентности', async () => {
    const { app, raid } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/raid/attack',
      headers: { authorization: `tma ${signedInitData()}`, 'idempotency-key': 'не-ключ' },
      payload: { raidId, expectedRevision: 4 },
    });
    expect(response.statusCode).toBe(400);
    expect(raid.execute).not.toHaveBeenCalled();
  });

  it('прокидывает отказ правил с кодом и не теряет его в 500', async () => {
    const { app, raid } = await setup();
    raid.execute.mockRejectedValueOnce(
      new GameRuleError('SEAL_INCOMPLETE', 'Алтарь печати не собран.'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/raid/summon',
      headers: { authorization: `tma ${signedInitData()}`, 'idempotency-key': randomUUID() },
      payload: { expectedRevision: 0, confirmed: true },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SEAL_INCOMPLETE');
  });

  it('предлагает повторить запрос при конфликте ревизии', async () => {
    const { app, raid } = await setup();
    raid.execute.mockRejectedValueOnce(new GameRuleError('STALE_RAID', 'Рейд изменился.'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/raid/attack',
      headers: { authorization: `tma ${signedInitData()}`, 'idempotency-key': randomUUID() },
      payload: { raidId, expectedRevision: 1 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('STALE_RAID');
  });
});
