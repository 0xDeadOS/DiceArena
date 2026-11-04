import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { createDatabase, PrismaProfileRepository, PrismaRoomRepository } from '../src/index.js';
import type { PrismaClient } from '../src/index.js';
import { starterFaces } from '../../game-core/src/index.js';
import { buildApp } from '../../../apps/api/src/app.js';
import { NOW, signedInitData, TEST_TOKEN } from '../../../tests/fixtures.js';

const rawUrl = process.env.TEST_DATABASE_URL;
if (!rawUrl) throw new Error('Set TEST_DATABASE_URL to a separate PostgreSQL test database.');
const url = new URL(rawUrl);
if (!url.pathname.endsWith('_test'))
  throw new Error(
    'Integration database name must end in _test. Production databases are never used.',
  );
const schema = `test_${randomUUID().replaceAll('-', '')}`;
url.searchParams.set('schema', schema);
let db: PrismaClient;
let admin: pg.Client;
let profiles: PrismaProfileRepository;
let rooms: PrismaRoomRepository;
const alice = { id: 42, firstName: 'Алиса', username: 'alice' };
const bob = { id: 43, firstName: 'Боб', username: null };

beforeAll(async () => {
  admin = new pg.Client({ connectionString: rawUrl });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  await admin.query(`SET search_path TO "${schema}"`);
  const migration = await readFile(
    new URL('../prisma/migrations/20261104000000_initial/migration.sql', import.meta.url),
    'utf8',
  );
  await admin.query(migration);
  db = createDatabase(url.toString());
  await db.$connect();
  profiles = new PrismaProfileRepository(db);
  rooms = new PrismaRoomRepository(db);
});

beforeEach(async () => {
  await admin.query('TRUNCATE TABLE "Room", "User" CASCADE');
});
afterAll(async () => {
  await db?.$disconnect();
  if (admin) {
    await admin.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await admin.end();
  }
});
const room = () => rooms.ensureRoom(-1001234567890n, 'Обитель друзей', 'r_abcdefgh');
const dieData = (ownerId: string) => ({
  ownerId,
  baseType: 'BONE' as const,
  faces: starterFaces().map((face) => ({ ...face })),
  powerScore: 55,
});

describe('PostgreSQL 16 foundation', () => {
  it('creates exactly the v2 starter kit in one transaction', async () => {
    const context = await room();
    const hub = await profiles.openSession(context, alice, NOW);
    expect(hub.player.gold).toBe(150);
    expect(hub.player.vigor.current).toBe(3);
    expect(hub.inventory.dice).toHaveLength(1);
    expect(hub.inventory.dice[0]).toMatchObject({
      baseType: 'BONE',
      isStarter: true,
      isEquipped: true,
      powerScore: 55,
    });
    expect(hub.inventory.spheres).toEqual([
      { type: 'TEMPERING', amount: 2 },
      { type: 'FACETING', amount: 1 },
      { type: 'CASTING', amount: 3 },
      { type: 'ASCENDANCE', amount: 0 },
      { type: 'RESHAPING', amount: 0 },
      { type: 'CLEANSING', amount: 0 },
    ]);
    expect(hub.player.firstName).toBe('Алиса');
  });

  it('does not duplicate the starter kit during 20 simultaneous registrations', async () => {
    const context = await room();
    const hubs = await Promise.all(
      Array.from({ length: 20 }, () => profiles.openSession(context, alice, NOW)),
    );
    expect(new Set(hubs.map((hub) => hub.player.id)).size).toBe(1);
    expect(new Set(hubs.map((hub) => hub.player.equippedDieId)).size).toBe(1);
    expect(await db.user.count()).toBe(1);
    expect(await db.roomMember.count()).toBe(1);
    expect(await db.die.count()).toBe(1);
    expect((await db.userCurrency.aggregate({ _sum: { amount: true } }))._sum.amount).toBe(6);
  });

  it('isolates characters, currency and equipment in two chats for the same Telegram user', async () => {
    const context = await room();
    const other = await rooms.ensureRoom(-1009999999999n, 'Другая Обитель', 'r_ijklmnop');
    const [one, two] = await Promise.all([
      profiles.openSession(context, alice, NOW),
      profiles.openSession(other, alice, NOW),
    ]);
    expect(await db.user.count()).toBe(1);
    expect(await db.roomMember.count()).toBe(2);
    expect(one.player.id).not.toBe(two.player.id);
    expect(one.player.equippedDieId).not.toBe(two.player.equippedDieId);
    await db.roomMember.update({ where: { id: one.player.id }, data: { gold: 1 } });
    expect((await profiles.loadHub(other, alice, NOW))?.player.gold).toBe(150);
  });

  it('never resets balances on a repeat session', async () => {
    const context = await room();
    const hub = await profiles.openSession(context, alice, NOW);
    await db.roomMember.update({ where: { id: hub.player.id }, data: { gold: 7 } });
    await db.userCurrency.updateMany({ where: { ownerId: hub.player.id }, data: { amount: 0 } });
    const again = await profiles.openSession(context, { ...alice, firstName: 'Новое имя' }, NOW);
    expect(again.player.gold).toBe(7);
    expect(again.player.firstName).toBe('Новое имя');
    expect(again.inventory.spheres.every((sphere) => sphere.amount === 0)).toBe(true);
  });

  it('rolls back the entire registration if a later wallet write fails', async () => {
    const context = await room();
    await admin.query(
      'ALTER TABLE "UserCurrency" ADD CONSTRAINT test_wallet_failure CHECK ("amount" = 0) NOT VALID',
    );
    try {
      await expect(profiles.openSession(context, alice, NOW)).rejects.toThrow();
      expect(await db.user.count()).toBe(0);
      expect(await db.roomMember.count()).toBe(0);
      expect(await db.die.count()).toBe(0);
    } finally {
      await admin.query('ALTER TABLE "UserCurrency" DROP CONSTRAINT test_wallet_failure');
    }
    expect((await profiles.openSession(context, alice, NOW)).inventory.dice).toHaveLength(1);
  });

  it('enforces equipment ownership at database level, not just in a route', async () => {
    const context = await room();
    const a = await profiles.openSession(context, alice, NOW);
    const b = await profiles.openSession(context, bob, NOW);
    // Make it unequipped, so only the ownership FK (not equippedDieId uniqueness) can protect it.
    await db.roomMember.update({ where: { id: b.player.id }, data: { equippedDieId: null } });
    await expect(
      db.roomMember.update({
        where: { id: a.player.id },
        data: { equippedDieId: b.player.equippedDieId },
      }),
    ).rejects.toMatchObject({ code: 'P2003' });
    expect((await profiles.loadHub(context, alice, NOW))?.player.equippedDieId).toBe(
      a.player.equippedDieId,
    );
  });

  it('rejects negative balances, invalid quality and duplicate starter dice', async () => {
    const hub = await profiles.openSession(await room(), alice, NOW);
    await expect(
      db.roomMember.update({ where: { id: hub.player.id }, data: { gold: -1 } }),
    ).rejects.toThrow();
    await expect(
      db.userCurrency.updateMany({ where: { ownerId: hub.player.id }, data: { amount: -1 } }),
    ).rejects.toThrow();
    await expect(
      db.die.update({ where: { id: hub.player.equippedDieId! }, data: { quality: 21 } }),
    ).rejects.toThrow();
    await expect(
      db.die.create({ data: { ...dieData(hub.player.id), isStarter: true } }),
    ).rejects.toThrow();
  });

  it('refills vigor once per UTC day without duplicate credits on concurrent loads', async () => {
    const context = await room();
    const hub = await profiles.openSession(context, alice, NOW);
    await db.roomMember.update({ where: { id: hub.player.id }, data: { storedVigor: 0 } });
    const tomorrow = new Date('2026-11-05T01:00:00Z');
    const hubs = await Promise.all(
      Array.from({ length: 10 }, () => profiles.loadHub(context, alice, tomorrow)),
    );
    expect(hubs.every((item) => item?.player.vigor.current === 3)).toBe(true);
    expect(
      (await profiles.loadHub(context, alice, new Date('2026-11-10T00:00:00Z')))?.player.vigor
        .current,
    ).toBe(6);
  });

  it('serializes a run summary without its map seed, battle seed or internal graph', async () => {
    const context = await room();
    const hub = await profiles.openSession(context, alice, NOW);
    await db.mapRun.create({
      data: {
        ownerId: hub.player.id,
        seed: 'a'.repeat(64),
        dagMapData: { internal: 'secret-map' },
        playerHp: 42,
        playerMaxHp: 50,
        battles: {
          create: {
            battleSeed: 'b'.repeat(64),
            enemyType: 'SLIME',
            enemyHp: 20,
            enemyMaxHp: 20,
            currentIntent: { action: 'STRIKE', value: 5 },
          },
        },
      },
    });
    const loaded = await profiles.loadHub(context, alice, NOW);
    expect(loaded?.activeRun).toMatchObject({ playerHp: 42, playerMaxHp: 50 });
    expect(JSON.stringify(loaded)).not.toMatch(
      /seed|battleSeed|secret-map|telegramUserId|telegramChatId/i,
    );
  });

  it('allows many historical battles, but just one active run and one unfinished battle', async () => {
    const hub = await profiles.openSession(await room(), alice, NOW);
    const data = {
      ownerId: hub.player.id,
      seed: 'a'.repeat(64),
      dagMapData: {},
      playerHp: 50,
      playerMaxHp: 50,
    };
    const run = await db.mapRun.create({ data });
    await expect(db.mapRun.create({ data })).rejects.toThrow();
    const battle = {
      runId: run.id,
      battleSeed: 'b'.repeat(64),
      enemyType: 'SLIME',
      enemyHp: 20,
      enemyMaxHp: 20,
      currentIntent: {},
    };
    const first = await db.battle.create({ data: battle });
    await expect(db.battle.create({ data: battle })).rejects.toThrow();
    await db.battle.update({ where: { id: first.id }, data: { state: 'FINISHED' } });
    await expect(db.battle.create({ data: battle })).resolves.toBeTruthy();
    expect(await db.battle.count()).toBe(2);
  });

  it('rejects a decision state without a persisted rolled face', async () => {
    const hub = await profiles.openSession(await room(), alice, NOW);
    const run = await db.mapRun.create({
      data: {
        ownerId: hub.player.id,
        seed: 'a'.repeat(64),
        dagMapData: {},
        playerHp: 50,
        playerMaxHp: 50,
      },
    });
    await expect(
      db.battle.create({
        data: {
          runId: run.id,
          battleSeed: 'b'.repeat(64),
          state: 'AWAITING_DECISION',
          enemyType: 'SLIME',
          enemyHp: 20,
          enemyMaxHp: 20,
          currentIntent: {},
        },
      }),
    ).rejects.toThrow();
  });

  it('scopes idempotency response records to their owner', async () => {
    const context = await room();
    const a = await profiles.openSession(context, alice, NOW);
    const b = await profiles.openSession(context, bob, NOW);
    const data = {
      key: randomUUID(),
      requestHash: 'a'.repeat(64),
      responseStatus: 200,
      responseBody: { ok: true },
      expiresAt: new Date(Date.now() + 86_400_000),
    };
    await db.idempotencyRecord.create({ data: { ...data, memberId: a.player.id } });
    await expect(
      db.idempotencyRecord.create({ data: { ...data, memberId: a.player.id } }),
    ).rejects.toThrow();
    await expect(
      db.idempotencyRecord.create({ data: { ...data, memberId: b.player.id } }),
    ).resolves.toBeTruthy();
  });

  it('preserves slug, character and inventory after supergroup migration', async () => {
    const context = await room();
    const before = await profiles.openSession(context, alice, NOW);
    await rooms.migrateChat(context.telegramChatId, -1008888888888n);
    const afterRoom = await profiles.findRoom(context.slug);
    expect(afterRoom?.telegramChatId).toBe(-1008888888888n);
    expect(afterRoom?.id).toBe(context.id);
    const after = await profiles.loadHub(afterRoom!, alice, NOW);
    expect(after?.player.id).toBe(before.player.id);
    expect(after?.inventory).toEqual(before.inventory);
    await rooms.setCanSendMessages(-1008888888888n, false);
    expect((await db.room.findUniqueOrThrow({ where: { id: context.id } })).canSendMessages).toBe(
      false,
    );
  });

  it('authenticates HTTP -> membership -> PostgreSQL -> safe hub DTO', async () => {
    await room();
    const app = await buildApp({
      profiles,
      membership: { assertMember: async () => undefined },
      botToken: TEST_TOKEN,
      clock: () => NOW,
      logLevel: false,
    });
    try {
      const headers = { authorization: `tma ${signedInitData()}` };
      const created = await app.inject({
        method: 'POST',
        url: '/api/auth/session',
        headers,
        payload: {},
      });
      expect(created.statusCode).toBe(200);
      const loaded = await app.inject({ url: '/api/hub', headers });
      expect(loaded.statusCode).toBe(200);
      expect(loaded.json()).toEqual(created.json().hub);
      expect(await db.die.count()).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('does not provision a new player via GET hub', async () => {
    expect(await profiles.loadHub(await room(), alice, NOW)).toBeNull();
    expect(await db.user.count()).toBe(0);
  });
});
