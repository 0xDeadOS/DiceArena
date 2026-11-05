import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RoomContext, RunDTO, SphereType } from '@dicebound/shared-types';
import {
  craftDie,
  evaluateDiePowerScore,
  parseCombatDie,
  starterFaces,
} from '@dicebound/game-core';
import { createDatabase, PrismaInventoryRepository } from '../src/index.js';
import type { InventoryCommand } from '../src/index.js';
import { battleFace } from '../src/random.js';
import { databaseHarness } from './harness.js';
import type { DatabaseHarness } from './harness.js';
import { buildApp } from '../../../apps/api/src/app.js';
import { NOW, signedInitData, TEST_TOKEN } from '../../../tests/fixtures.js';
let h: DatabaseHarness;
let room: RoomContext;
let owner: string;
let starter: string;
const alice = { id: 42, firstName: 'Алиса', username: 'alice' };
const bob = { id: 43, firstName: 'Боб', username: null };
beforeAll(async () => {
  h = await databaseHarness();
});
beforeEach(async () => {
  await h.reset();
  room = await h.rooms.ensureRoom(-1001234567890n, 'Обитель', 'r_abcdefgh');
  const hub = await h.profiles.openSession(room, alice, NOW);
  owner = hub.player.id;
  starter = hub.player.equippedDieId!;
});
afterAll(async () => {
  await h?.close();
});
const current = () => h.inventory.current(room, alice, NOW);
const exec = (cmd: InventoryCommand, key = randomUUID(), now = NOW) =>
  h.inventory.execute(room, alice, cmd, key, now);
const useSphere = (
  sphere: SphereType,
  expectedRevision: number,
  dieId = starter,
  key = randomUUID(),
) => exec({ type: 'CRAFT', dieId, expectedRevision, sphere, confirmed: true }, key);
const secondDie = () =>
  h.db.die.create({
    data: {
      ownerId: owner,
      baseType: 'IRON',
      faces: starterFaces().map((f) => ({ ...f })),
      powerScore: 59,
    },
  });
async function win(run: RunDTO) {
  for (let i = 0; i < 100; i++) {
    const seed = createHash('sha256').update(`workshop-test:${i}`).digest('hex');
    if (battleFace(seed, 0) !== 1) continue;
    await h.db.battle.update({
      where: { id: run.battle!.id },
      data: { battleSeed: seed, enemyHp: 1 },
    });
    break;
  }
  const rolled = await h.game.execute(
    room,
    alice,
    { type: 'ROLL', runId: run.id, battleId: run.battle!.id, expectedRevision: run.revision },
    randomUUID(),
    NOW,
  );
  return h.game.execute(
    room,
    alice,
    {
      type: 'DECISION',
      runId: run.id,
      battleId: run.battle!.id,
      expectedRevision: rolled.revision,
      action: 'DIRECT',
    },
    randomUUID(),
    NOW,
  );
}
async function enterBattle() {
  const run = await h.game.execute(room, alice, { type: 'START' }, randomUUID(), NOW);
  return h.game.execute(
    room,
    alice,
    { type: 'STEP', runId: run.id, nodeId: 'f1-0', expectedRevision: 0 },
    randomUUID(),
    NOW,
  );
}
describe('PostgreSQL inventory and workshop', () => {
  it('loads policies without consuming resources or producing a random craft preview', async () => {
    const a = await current();
    expect(await current()).toEqual(a);
    expect(a.hub.player.inventoryRevision).toBe(0);
    expect(a.policies[0]?.dismantle.allowed).toBe(false);
    expect(a.policies[0]?.craft.find((o) => o.sphere === 'CASTING')).toMatchObject({
      allowed: true,
      cost: 1,
      destructive: false,
    });
    expect(a.policies[0]?.craft.find((o) => o.sphere === 'ASCENDANCE')?.allowed).toBe(false);
    expect(a.hub.inventory.dice[0]?.effectiveFaces).toEqual(starterFaces());
    expect(await h.db.idempotencyRecord.count()).toBe(0);
    for (const secret of ['seed', 'telegramUserId', 'ownerId', 'requestHash'])
      expect(JSON.stringify(a)).not.toContain(secret);
  });
  it('does not register through inventory endpoints', async () => {
    await expect(h.inventory.current(room, bob, NOW)).rejects.toMatchObject({
      code: 'SESSION_REQUIRED',
    });
    await expect(
      h.inventory.execute(
        room,
        bob,
        { type: 'EQUIP', dieId: starter, expectedRevision: 0 },
        randomUUID(),
        NOW,
      ),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
  });
  it('twenty simultaneous retries consume one sphere and produce the exact same craft', async () => {
    const key = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => useSphere('CASTING', 0, starter, key)),
    );
    for (const result of results) expect(result).toEqual(results[0]);
    expect(results[0]?.inventory.hub.player.inventoryRevision).toBe(1);
    expect(await h.db.idempotencyRecord.count()).toBe(1);
    const die = await h.db.die.findUniqueOrThrow({ where: { id: starter } });
    expect(die).toMatchObject({ rarity: 'MAGIC', contentVersion: 1, isStarter: true });
    expect(die.powerScore).toBe(evaluateDiePowerScore(parseCombatDie(die)));
    expect(
      (
        await h.db.userCurrency.findUniqueOrThrow({
          where: { ownerId_sphereType: { ownerId: owner, sphereType: 'CASTING' } },
        })
      ).amount,
    ).toBe(2);
  });
  it('two services racing the last sphere cannot double-spend, even on different items', async () => {
    const other = await secondDie();
    await h.db.userCurrency.update({
      where: { ownerId_sphereType: { ownerId: owner, sphereType: 'CASTING' } },
      data: { amount: 1 },
    });
    const db = createDatabase(h.url);
    const replica = new PrismaInventoryRepository(db);
    try {
      const results = await Promise.allSettled([
        useSphere('CASTING', 0),
        replica.execute(
          room,
          alice,
          {
            type: 'CRAFT',
            dieId: other.id,
            expectedRevision: 0,
            sphere: 'CASTING',
            confirmed: true,
          },
          randomUUID(),
          NOW,
        ),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const state = await current();
      expect(state.hub.inventory.spheres.find((s) => s.type === 'CASTING')?.amount).toBe(0);
      expect(state.hub.player.inventoryRevision).toBe(1);
      await expect(useSphere('CASTING', 1)).rejects.toMatchObject({ code: 'SPHERE_MISSING' });
      expect((await current()).hub.player.inventoryRevision).toBe(1);
    } finally {
      await db.$disconnect();
    }
  });
  it('equips exactly one owned die and freezes its public effective values', async () => {
    const other = await secondDie();
    const key = randomUUID();
    const cmd = { type: 'EQUIP' as const, dieId: other.id, expectedRevision: 0 };
    const result = await exec(cmd, key);
    expect(await exec(cmd, key)).toEqual(result);
    expect(
      result.inventory.hub.inventory.dice.filter((d) => d.isEquipped).map((d) => d.id),
    ).toEqual([other.id]);
    expect(
      result.inventory.hub.inventory.dice.find((d) => d.id === other.id)?.effectiveFaces[1]?.value,
    ).toBe(6);
    await expect(exec({ ...cmd, expectedRevision: 1 })).rejects.toMatchObject({
      code: 'ALREADY_EQUIPPED',
    });
  });
  it('lock prevents all crafting and destruction, but does not prevent equipping', async () => {
    const other = await secondDie();
    await exec({ type: 'LOCK', dieId: other.id, expectedRevision: 0, locked: true });
    await expect(useSphere('TEMPERING', 1, other.id)).rejects.toMatchObject({ code: 'DIE_LOCKED' });
    await expect(
      exec({ type: 'DISMANTLE', dieId: other.id, expectedRevision: 1, confirmed: true }),
    ).rejects.toMatchObject({ code: 'DISMANTLE_FORBIDDEN' });
    await exec({ type: 'EQUIP', dieId: other.id, expectedRevision: 1 });
    await exec({ type: 'LOCK', dieId: other.id, expectedRevision: 2, locked: false });
    expect((await useSphere('TEMPERING', 3, other.id)).result.type).toBe('CRAFT');
  });
  it('protects starter even unequipped, equipped items, and missing confirmation', async () => {
    const other = await secondDie();
    await exec({ type: 'EQUIP', dieId: other.id, expectedRevision: 0 });
    for (const dieId of [starter, other.id])
      await expect(
        exec({ type: 'DISMANTLE', dieId, expectedRevision: 1, confirmed: true }),
      ).rejects.toMatchObject({ code: 'DISMANTLE_FORBIDDEN' });
    await expect(
      exec({ type: 'DISMANTLE', dieId: starter, expectedRevision: 1, confirmed: false as true }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect(await h.db.die.count()).toBe(2);
  });
  it('dismantles an unused die and grants dust exactly once, including replay after deletion', async () => {
    const other = await secondDie();
    const key = randomUUID();
    const cmd = {
      type: 'DISMANTLE' as const,
      dieId: other.id,
      expectedRevision: 0,
      confirmed: true as const,
    };
    const [a, b] = await Promise.all([exec(cmd, key), exec(cmd, key)]);
    expect(b).toEqual(a);
    expect(a.result).toEqual({ type: 'DISMANTLE', dieId: other.id, dust: 1 });
    expect(a.inventory.hub.player.facetDust).toBe(1);
    expect(await h.db.die.count()).toBe(1);
    await expect(exec({ ...cmd, expectedRevision: 1 })).rejects.toMatchObject({
      code: 'DIE_NOT_FOUND',
    });
    expect((await current()).hub.player.facetDust).toBe(1);
  });
  it('different concurrent dismantle keys do not both grant salvage', async () => {
    const other = await secondDie();
    const cmd = {
      type: 'DISMANTLE' as const,
      dieId: other.id,
      expectedRevision: 0,
      confirmed: true as const,
    };
    const results = await Promise.allSettled([exec(cmd), exec(cmd)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await current()).hub.player.facetDust).toBe(1);
  });
  it('a lock/craft race cannot slip a craft past a committed lock', async () => {
    const results = await Promise.allSettled([
      exec({ type: 'LOCK', dieId: starter, expectedRevision: 0, locked: true }),
      useSphere('CASTING', 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const state = await current();
    const die = state.hub.inventory.dice[0]!;
    if (die.isLocked) {
      expect(die.rarity).toBe('NORMAL');
      expect(state.hub.inventory.spheres.find((s) => s.type === 'CASTING')?.amount).toBe(3);
    } else expect(die.contentVersion).toBe(1);
  });
  it('rejects altered requests and reuse of a gameplay nonce across feature namespaces', async () => {
    const key = randomUUID();
    const result = await useSphere('CASTING', 0, starter, key);
    await expect(useSphere('TEMPERING', 0, starter, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await expect(h.game.execute(room, alice, { type: 'START' }, key, NOW)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    expect(await useSphere('CASTING', 0, starter, key)).toEqual(result);
    expect(await h.db.mapRun.count()).toBe(0);
  });
  it('shares replay compatibility and expiry tombstones with gameplay operations', async () => {
    const key = randomUUID();
    await useSphere('TEMPERING', 0, starter, key);
    const later = new Date(NOW.getTime() + 86_400_001);
    await h.game.execute(room, alice, { type: 'START' }, randomUUID(), later);
    await expect(
      exec(
        {
          type: 'CRAFT',
          dieId: starter,
          expectedRevision: 0,
          sphere: 'TEMPERING',
          confirmed: true,
        },
        key,
        later,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_EXPIRED' });
    expect(
      (
        await h.db.idempotencyRecord.findUniqueOrThrow({
          where: { memberId_key: { memberId: owner, key } },
        })
      ).responseBody,
    ).toEqual({ expired: true });
  });
  it('isolates room ownership and replay responses for the same UUID', async () => {
    const key = randomUUID();
    await useSphere('TEMPERING', 0, starter, key);
    await h.profiles.openSession(room, bob, NOW);
    const other = await h.rooms.ensureRoom(-100456n, 'Другая', 'r_ijklmnop');
    await h.profiles.openSession(other, alice, NOW);
    for (const [context, identity] of [
      [room, bob],
      [other, alice],
    ] as const) {
      await expect(
        h.inventory.execute(
          context,
          identity,
          {
            type: 'CRAFT',
            dieId: starter,
            expectedRevision: 0,
            sphere: 'CASTING',
            confirmed: true,
          },
          randomUUID(),
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'DIE_NOT_FOUND' });
      const own = await h.inventory.current(context, identity, NOW);
      const local = own.hub.player.equippedDieId!;
      const result = await h.inventory.execute(
        context,
        identity,
        { type: 'CRAFT', dieId: local, expectedRevision: 0, sphere: 'TEMPERING', confirmed: true },
        key,
        NOW,
      );
      expect(result.result.dieId).toBe(local);
      expect(local).not.toBe(starter);
    }
  });
  it('all six spheres update the same item, preserve protected metadata and spend only one each', async () => {
    await h.db.userCurrency.updateMany({ where: { ownerId: owner }, data: { amount: 3 } });
    await h.db.die.update({
      where: { id: starter },
      data: { masterCrafted: true, lastVictoryAt: NOW, lastVictoryPowerScore: 55 },
    });
    let revision = 0;
    for (const sphere of [
      'TEMPERING',
      'FACETING',
      'CASTING',
      'ASCENDANCE',
      'RESHAPING',
      'CLEANSING',
    ] as const) {
      const result = await useSphere(sphere, revision++);
      expect(result.result.type).toBe('CRAFT');
      const die = result.inventory.hub.inventory.dice[0]!;
      expect(die).toMatchObject({
        id: starter,
        isStarter: true,
        masterCrafted: true,
        isEquipped: true,
        contentVersion: revision,
      });
      expect(die.powerScore).toBe(evaluateDiePowerScore(die));
    }
    const end = await current();
    expect(end.hub.inventory.dice).toHaveLength(1);
    expect(end.hub.inventory.dice[0]).toMatchObject({ rarity: 'NORMAL', affixes: [], quality: 5 });
    expect(end.hub.inventory.spheres.every((s) => s.amount === 2)).toBe(true);
    expect(end.hub.player.gold).toBe(150);
    expect(await h.db.die.findUnique({ where: { id: starter } })).toMatchObject({
      lastVictoryAt: null,
      lastVictoryPowerScore: null,
    });
  });
  it('quality cap and rarity failures are atomic and do not reserve the nonce', async () => {
    await h.db.die.update({ where: { id: starter }, data: { quality: 20 } });
    const key = randomUUID();
    await expect(useSphere('TEMPERING', 0, starter, key)).rejects.toMatchObject({
      code: 'QUALITY_MAXIMUM',
    });
    await expect(useSphere('ASCENDANCE', 0)).rejects.toMatchObject({ code: 'RARITY_MISMATCH' });
    expect(await h.db.idempotencyRecord.count()).toBe(0);
    await useSphere('CASTING', 0, starter, key);
    expect(
      (await current()).hub.inventory.spheres.find((s) => s.type === 'TEMPERING')?.amount,
    ).toBe(2);
  });
  it('craft during a run leaves the battle snapshot intact and cannot validate the new configuration', async () => {
    const run = await enterBattle();
    await useSphere('CASTING', 0);
    expect((await h.game.current(room, alice))?.loadout).toMatchObject({
      rarity: 'NORMAL',
      contentVersion: 0,
      affixes: [],
    });
    const won = await win(run);
    expect((await h.db.die.findUniqueOrThrow({ where: { id: starter } })).lastVictoryAt).toBeNull();
    await h.game.execute(
      room,
      alice,
      { type: 'RETREAT', runId: won.id, expectedRevision: won.revision },
      randomUUID(),
      NOW,
    );
    const fresh = await enterBattle();
    await win(fresh);
    const item = await h.db.die.findUniqueOrThrow({ where: { id: starter } });
    expect(item.lastVictoryAt).toEqual(NOW);
    expect(item.lastVictoryPowerScore).toBe(item.powerScore);
  });
  it('allows future equipment changes but prevents destroying the active-run die', async () => {
    const other = await secondDie();
    await exec({ type: 'EQUIP', dieId: other.id, expectedRevision: 0 });
    const run = await enterBattle();
    await exec({ type: 'EQUIP', dieId: starter, expectedRevision: 1 });
    expect((await h.game.current(room, alice))?.loadout.id).toBe(other.id);
    await expect(
      exec({ type: 'DISMANTLE', dieId: other.id, expectedRevision: 2, confirmed: true }),
    ).rejects.toMatchObject({ code: 'DISMANTLE_FORBIDDEN' });
    await h.game.execute(
      room,
      alice,
      { type: 'RETREAT', runId: run.id, expectedRevision: run.revision },
      randomUUID(),
      NOW,
    );
    expect(
      (await exec({ type: 'DISMANTLE', dieId: other.id, expectedRevision: 3, confirmed: true }))
        .result,
    ).toMatchObject({ dust: 1 });
  });
  it('updates the inventory revision on a training payout, rejecting stale economic snapshots', async () => {
    const run = await h.game.execute(room, alice, { type: 'START' }, randomUUID(), NOW);
    await h.game.execute(
      room,
      alice,
      { type: 'RETREAT', runId: run.id, expectedRevision: 0 },
      randomUUID(),
      NOW,
    );
    await expect(useSphere('TEMPERING', 0)).rejects.toMatchObject({ code: 'STALE_INVENTORY' });
    expect((await current()).hub.player.inventoryRevision).toBe(1);
  });
  it('rolls back sphere, random item contents, qualification, and revision if response storage fails', async () => {
    await h.db.die.update({
      where: { id: starter },
      data: { lastVictoryAt: NOW, lastVictoryPowerScore: 55 },
    });
    const before = await current();
    const key = randomUUID();
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "test_fail_craft" CHECK (false) NOT VALID',
    );
    try {
      await expect(useSphere('CASTING', 0, starter, key)).rejects.toThrow();
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "test_fail_craft"');
    }
    expect(await current()).toEqual(before);
    expect(await h.db.die.findUnique({ where: { id: starter } })).toMatchObject({
      lastVictoryAt: NOW,
      lastVictoryPowerScore: 55,
    });
    await useSphere('CASTING', 0, starter, key);
    expect((await current()).hub.player.inventoryRevision).toBe(1);
  });
  it('rolls back destruction and dust when caching the response fails', async () => {
    const other = await secondDie();
    const before = await current();
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "test_fail_dismantle" CHECK (false) NOT VALID',
    );
    try {
      await expect(
        exec({ type: 'DISMANTLE', dieId: other.id, expectedRevision: 0, confirmed: true }),
      ).rejects.toThrow();
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "test_fail_dismantle"');
    }
    expect(await current()).toEqual(before);
    expect(await h.db.die.count()).toBe(2);
  });
  it('database trigger serializes the last free slot and counters stay nonnegative', async () => {
    await h.db.die.createMany({
      data: Array.from({ length: 10 }, () => ({
        ownerId: owner,
        baseType: 'BONE' as const,
        faces: starterFaces().map((f) => ({ ...f })),
        powerScore: 55,
      })),
    });
    const results = await Promise.allSettled([secondDie(), secondDie()]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.db.die.count()).toBe(12);
    await expect(
      h.db.roomMember.update({ where: { id: owner }, data: { inventoryRevision: -1 } }),
    ).rejects.toThrow();
    await expect(
      h.db.die.update({ where: { id: starter }, data: { contentVersion: -1 } }),
    ).rejects.toThrow();
  });
  it('preserves high-tier properties when ascending, without changing the master marker', async () => {
    const item = parseCombatDie({
      ...(await h.db.die.findUniqueOrThrow({ where: { id: starter } })),
      ilvl: 20,
    });
    const magic = craftDie(item, 'CASTING', (max) => max - 1);
    await h.db.die.update({
      where: { id: starter },
      data: {
        ilvl: 20,
        rarity: 'MAGIC',
        affixes: magic.affixes.map((a) => ({ ...a })),
        masterCrafted: true,
      },
    });
    await h.db.userCurrency.update({
      where: { ownerId_sphereType: { ownerId: owner, sphereType: 'ASCENDANCE' } },
      data: { amount: 1 },
    });
    const result = await useSphere('ASCENDANCE', 0);
    const after = result.inventory.hub.inventory.dice[0]!;
    expect(after.affixes.slice(0, 2)).toEqual(magic.affixes);
    expect(after.masterCrafted).toBe(true);
  });
  it('signed HTTP crafting and repeated JSON payload return one persisted result', async () => {
    let time = NOW;
    const app = await buildApp({
      profiles: h.profiles,
      game: h.game,
      inventory: h.inventory,
      membership: { assertMember: async () => undefined },
      botToken: TEST_TOKEN,
      clock: () => time,
      logLevel: false,
    });
    try {
      const headers = { authorization: `tma ${signedInitData()}`, 'idempotency-key': randomUUID() };
      const body = { dieId: starter, expectedRevision: 0, sphere: 'CASTING', confirmed: true };
      const first = await app.inject({
        method: 'POST',
        url: '/api/workshop/craft',
        headers,
        payload: body,
      });
      expect(first.statusCode).toBe(200);
      time = new Date(time.getTime() + 1100);
      const again = await app.inject({
        method: 'POST',
        url: '/api/workshop/craft',
        headers,
        payload: body,
      });
      expect(again.json()).toEqual(first.json());
      const read = await app.inject({ url: '/api/inventory', headers });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toEqual(first.json().inventory);
      expect(await h.db.idempotencyRecord.count()).toBe(1);
    } finally {
      await app.close();
    }
  });
});
