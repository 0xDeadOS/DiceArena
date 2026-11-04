import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from './app.js';
import { AppError } from './errors.js';
import { fixtureHub, NOW, ROOM, signedInitData, TEST_TOKEN } from '../../../tests/fixtures.js';

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
  const app = await buildApp({
    profiles,
    membership,
    botToken: TEST_TOKEN,
    clock: () => NOW,
    logLevel: false,
  });
  apps.push(app);
  return { app, profiles, membership };
}
const headers = () => ({ authorization: `tma ${signedInitData()}` });

describe('Fastify API boundary', () => {
  it('creates an authorized session using only the signed identity and database chat ID', async () => {
    const { app, profiles, membership } = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      headers: headers(),
      payload: {},
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      hub: fixtureHub(),
      authExpiresAt: '2026-11-05T12:00:00.000Z',
    });
    expect(membership.assertMember).toHaveBeenCalledWith(ROOM.telegramChatId, 42);
    expect(profiles.openSession).toHaveBeenCalledWith(
      ROOM,
      { id: 42, firstName: 'Алиса', username: 'alice' },
      NOW,
    );
    expect(response.headers['cache-control']).toBe('no-store');
  });
  it('never hits the database or Telegram with a missing/forged signature', async () => {
    const { app, profiles, membership } = await setup();
    for (const authorization of ['', 'tma fake']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers: { authorization },
        payload: {},
      });
      expect(response.statusCode).toBe(401);
    }
    expect(profiles.findRoom).not.toHaveBeenCalled();
    expect(membership.assertMember).not.toHaveBeenCalled();
  });
  it('rejects client-supplied identity/context fields', async () => {
    const { app, profiles } = await setup();
    const post = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      headers: headers(),
      payload: { user_id: 999, chat_id: -100 },
    });
    const get = await app.inject({ url: '/api/hub?room_id=other', headers: headers() });
    expect(post.statusCode).toBe(400);
    expect(get.statusCode).toBe(400);
    expect(profiles.openSession).not.toHaveBeenCalled();
  });
  it('does not create a profile for a non-member', async () => {
    const { app, profiles, membership } = await setup();
    membership.assertMember.mockRejectedValue(
      new AppError(403, 'NOT_A_ROOM_MEMBER', 'Нет доступа.'),
    );
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/session',
      headers: headers(),
      payload: {},
    });
    expect(response.statusCode).toBe(403);
    expect(profiles.openSession).not.toHaveBeenCalled();
  });
  it('requires session initialization before GET hub', async () => {
    const { app, profiles } = await setup();
    profiles.loadHub.mockResolvedValue(null as never);
    const response = await app.inject({ url: '/api/hub', headers: headers() });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe('SESSION_REQUIRED');
  });
  it('returns 404 for an unregistered signed room', async () => {
    const { app, profiles, membership } = await setup();
    profiles.findRoom.mockResolvedValue(null as never);
    const response = await app.inject({ url: '/api/hub', headers: headers() });
    expect(response.statusCode).toBe(404);
    expect(membership.assertMember).not.toHaveBeenCalled();
  });
  it('limits signed users to five requests per second despite forwarded-IP spoofing', async () => {
    const { app } = await setup();
    for (let i = 0; i < 5; i++) {
      const response = await app.inject({
        url: '/api/hub',
        headers: { ...headers(), 'x-forwarded-for': `10.0.0.${i}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const denied = await app.inject({
      url: '/api/hub',
      headers: { ...headers(), 'x-forwarded-for': '10.0.1.99' },
    });
    expect(denied.statusCode).toBe(429);
    expect(denied.json().error.code).toBe('RATE_LIMITED');
  });
  it('does not expose driver errors or secrets', async () => {
    const { app, profiles } = await setup();
    profiles.loadHub.mockRejectedValue(new Error(`database password, ${TEST_TOKEN}, battleSeed`));
    const response = await app.inject({ url: '/api/hub', headers: headers() });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(TEST_TOKEN);
    expect(response.body).not.toContain('battleSeed');
    expect(response.json().error.requestId).toBeTruthy();
  });
  it('separates liveness from database readiness', async () => {
    const { app, profiles } = await setup();
    expect((await app.inject('/health/live')).statusCode).toBe(200);
    expect((await app.inject('/health/ready')).statusCode).toBe(200);
    profiles.isReady.mockRejectedValue(new Error('secret connection URL'));
    expect((await app.inject('/health/ready')).statusCode).toBe(503);
  });
  it('does not pretend the future game endpoints are implemented', async () => {
    const { app } = await setup();
    expect(
      (await app.inject({ method: 'POST', url: '/api/battle/roll', headers: headers() }))
        .statusCode,
    ).toBe(404);
  });
});
