import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RoomContext, RunDTO } from '@dicebound/shared-types';
import {
  generateDrop,
  emptyExpeditionLoot,
  settleExpeditionLoot,
  expeditionLootSchema,
} from '@dicebound/game-core';
import { PrismaGameRepository, PrismaInventoryRepository } from '../src/index.js';
import type { GameCommand, InventoryCommand } from '../src/index.js';
import { secretInt } from '../src/random.js';
import { databaseHarness } from './harness.js';
import type { DatabaseHarness } from './harness.js';
import { NOW, signedInitData, TEST_TOKEN } from '../../../tests/fixtures.js';
import { buildApp } from '../../../apps/api/src/app.js';
let h: DatabaseHarness, room: RoomContext, owner: string, starter: string;
const alice = { id: 42, firstName: 'Алиса', username: 'alice' };
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
const game = (command: GameCommand, key = randomUUID(), now = NOW) =>
  h.game.execute(room, alice, command, key, now);
const inventory = (command: InventoryCommand, key = randomUUID()) =>
  h.inventory.execute(room, alice, command, key, NOW);
const profile = () => h.db.roomMember.findUniqueOrThrow({ where: { id: owner } });
async function unlocked() {
  await h.db.roomMember.update({
    where: { id: owner },
    data: {
      tutorialTrainingWon: true,
      tutorialCrafted: true,
      tutorialRewardClaimed: true,
      tutorialDone: true,
    },
  });
}
const normal = (revision = 0, level = 1, key = randomUUID(), now = NOW) =>
  game(
    { type: 'EXPEDITION', level, expectedInventoryRevision: revision, confirmed: true },
    key,
    now,
  );
const retreat = (r: RunDTO, key = randomUUID()) =>
  game({ type: 'RETREAT', runId: r.id, expectedRevision: r.revision }, key);
async function winBattle(run: RunDTO) {
  // Fixture accelerates traversal, not balance: actual scaling is tested independently.
  await h.db.battle.update({
    where: { id: run.battle!.id },
    data: { state: 'AWAITING_DECISION', currentRolledFace: 3, enemyHp: 1 },
  });
  return game({
    type: 'DECISION',
    runId: run.id,
    battleId: run.battle!.id,
    expectedRevision: run.revision,
    action: 'DIRECT',
  });
}
async function finish(run: RunDTO) {
  while (run.status === 'IN_PROGRESS') {
    if (run.battle && run.battle.state !== 'FINISHED') run = await winBattle(run);
    else {
      const nodes = run.nodes.filter((n) => run.availableNodeIds.includes(n.id));
      const next =
        nodes.find((n) => n.type === 'CHEST') ?? nodes.find((n) => n.type === 'CAMP') ?? nodes[0]!;
      run = await game({
        type: 'STEP',
        runId: run.id,
        nodeId: next.id,
        expectedRevision: run.revision,
      });
    }
  }
  return run;
}
function fixtureLoot(count = 5) {
  return {
    ...emptyExpeditionLoot(),
    gold: 101,
    dust: 11,
    spheres: [
      { type: 'CASTING' as const, amount: 5 },
      { type: 'ASCENDANCE' as const, amount: 1 },
    ],
    dice: Array.from({ length: count }, () => generateDrop(randomUUID(), 1, () => 0)),
  };
}
async function injectLoot(run: RunDTO, count = 5) {
  const loot = fixtureLoot(count);
  await h.db.mapRun.update({
    where: { id: run.id },
    data: { accumulatedLoot: JSON.parse(JSON.stringify(loot)) },
  });
  return loot;
}
async function awardPending() {
  await unlocked();
  const run = await normal();
  await injectLoot(run);
  await retreat(run);
  return h.db.pendingDrop.findMany({ where: { ownerId: owner }, orderBy: { id: 'asc' } });
}
async function fillBag() {
  const original = await h.db.die.findUniqueOrThrow({ where: { id: starter } });
  while ((await h.db.die.count({ where: { ownerId: owner } })) < 12)
    await h.db.die.create({
      data: {
        ownerId: owner,
        baseType: 'BONE',
        faces: original.faces!,
        affixes: [],
        powerScore: 55,
      },
    });
}

describe('verified onboarding', () => {
  it('requires real training victory, pays the learning sphere once, records craft and unlocks explicitly', async () => {
    await expect(
      inventory({ type: 'TUTORIAL_REWARD', expectedRevision: 0, confirmed: true }),
    ).rejects.toMatchObject({ code: 'TRAINING_REQUIRED' });
    await expect(normal()).rejects.toMatchObject({ code: 'TUTORIAL_REQUIRED' });
    await finish(await game({ type: 'START' }));
    expect((await profile()).tutorialTrainingWon).toBe(true);
    expect((await h.profiles.loadHub(room, alice, NOW))!.player.tutorial.step).toBe('REWARD');
    const key = randomUUID();
    const cmd = { type: 'TUTORIAL_REWARD' as const, expectedRevision: 1, confirmed: true as const };
    const replies = await Promise.all(Array.from({ length: 20 }, () => inventory(cmd, key)));
    for (const reply of replies) expect(reply).toEqual(replies[0]);
    expect(
      replies[0]!.inventory.hub.inventory.spheres.find((s) => s.type === 'CASTING')!.amount,
    ).toBe(4);
    await expect(inventory({ ...cmd, expectedRevision: 2 })).rejects.toMatchObject({
      code: 'REWARD_ALREADY_CLAIMED',
    });
    await expect(
      inventory({ type: 'TUTORIAL_COMPLETE', expectedRevision: 2, confirmed: true }),
    ).rejects.toMatchObject({ code: 'TUTORIAL_INCOMPLETE' });
    const crafted = await inventory({
      type: 'CRAFT',
      dieId: starter,
      expectedRevision: 2,
      sphere: 'CASTING',
      confirmed: true,
    });
    expect(crafted.inventory.hub.player.tutorial.step).toBe('COMPLETE');
    await inventory({ type: 'TUTORIAL_COMPLETE', expectedRevision: 3, confirmed: true });
    expect((await profile()).tutorialDone).toBe(true);
    await normal(4);
    expect((await profile()).storedVigor).toBe(2);
  });
  it('credits a craft before training and never grants tutorial progress for a retreat', async () => {
    await inventory({
      type: 'CRAFT',
      dieId: starter,
      expectedRevision: 0,
      sphere: 'TEMPERING',
      confirmed: true,
    });
    await retreat(await game({ type: 'START' }));
    const p = await profile();
    expect(p.tutorialCrafted).toBe(true);
    expect(p.tutorialTrainingWon).toBe(false);
    expect(p.tutorialDone).toBe(false);
  });
  it('retains the reward and progress atomically when response persistence fails', async () => {
    await h.db.roomMember.update({ where: { id: owner }, data: { tutorialTrainingWon: true } });
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT test_reject CHECK (false) NOT VALID',
    );
    try {
      await expect(
        inventory({ type: 'TUTORIAL_REWARD', expectedRevision: 0, confirmed: true }),
      ).rejects.toThrow();
      expect((await profile()).tutorialRewardClaimed).toBe(false);
      expect((await profile()).inventoryRevision).toBe(0);
      expect(
        (
          await h.db.userCurrency.findUniqueOrThrow({
            where: { ownerId_sphereType: { ownerId: owner, sphereType: 'CASTING' } },
          })
        ).amount,
      ).toBe(3);
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT test_reject');
    }
  });
  it('rejects skipping server flags even through a raw SQL mistake', async () => {
    await expect(
      h.db.roomMember.update({ where: { id: owner }, data: { tutorialDone: true } }),
    ).rejects.toThrow();
  });
});

describe('normal expeditions and durable drop settlement', () => {
  it('twenty identical starts spend exactly one vigor and preserve a single difficulty/loadout snapshot', async () => {
    await unlocked();
    const key = randomUUID();
    const replies = await Promise.all(Array.from({ length: 20 }, () => normal(0, 1, key)));
    for (const reply of replies) expect(reply).toEqual(replies[0]);
    expect(await h.db.mapRun.count()).toBe(1);
    expect(await profile()).toMatchObject({ storedVigor: 2, inventoryRevision: 1 });
    expect(replies[0]).toMatchObject({ mode: 'EXPEDITION', level: 1 });
    expect(await h.db.mapRun.findUniqueOrThrow({ where: { id: replies[0]!.id } })).toMatchObject({
      hasVigorBoost: true,
      enemyScale: 1000,
    });
  });
  it('two services with different nonces cannot overspend the last vigor', async () => {
    await unlocked();
    await h.db.roomMember.update({ where: { id: owner }, data: { storedVigor: 1 } });
    const other = new PrismaGameRepository(h.db);
    const cmd = {
      type: 'EXPEDITION' as const,
      level: 1,
      expectedInventoryRevision: 0,
      confirmed: true as const,
    };
    const results = await Promise.allSettled([
      game(cmd),
      other.execute(room, alice, cmd, randomUUID(), NOW),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await profile()).storedVigor).toBe(0);
    expect(await h.db.mapRun.count()).toBe(1);
  });
  it('refreshes UTC vigor before charging and keeps training free at zero vigor', async () => {
    await unlocked();
    await h.db.roomMember.update({ where: { id: owner }, data: { storedVigor: 0 } });
    await expect(normal()).rejects.toMatchObject({ code: 'NO_VIGOR' });
    const training = await game({ type: 'START' });
    expect((await profile()).storedVigor).toBe(0);
    await retreat(training);
    await normal(1, 1, randomUUID(), new Date(NOW.getTime() + 86400000));
    expect((await profile()).storedVigor).toBe(2);
  });
  it('rejects locked levels and stale wallet revisions without changing vigor', async () => {
    await unlocked();
    await expect(normal(0, 2)).rejects.toMatchObject({ code: 'LEVEL_LOCKED' });
    await expect(normal(4)).rejects.toMatchObject({ code: 'STALE_INVENTORY' });
    expect((await profile()).storedVigor).toBe(3);
    expect(await h.db.mapRun.count()).toBe(0);
  });
  it('rolls back vigor, revision and route when caching a start fails', async () => {
    await unlocked();
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT test_reject CHECK (false) NOT VALID',
    );
    try {
      await expect(normal()).rejects.toThrow();
      expect(await profile()).toMatchObject({ storedVigor: 3, inventoryRevision: 0 });
      expect(await h.db.mapRun.count()).toBe(0);
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT test_reject');
    }
  });
  it('persists scaled intentions/rolls across repository reload without exposing future loot or RNG', async () => {
    await unlocked();
    let run = await normal();
    run = await game({
      type: 'STEP',
      runId: run.id,
      nodeId: run.availableNodeIds[0]!,
      expectedRevision: run.revision,
    });
    expect(run.battle).toMatchObject({
      enemyHp: 20,
      currentIntent: { value: 5 },
      enemyScale: 1000,
    });
    const rolled = await game({
      type: 'ROLL',
      runId: run.id,
      battleId: run.battle!.id,
      expectedRevision: run.revision,
    });
    expect(await new PrismaGameRepository(h.db).current(room, alice)).toEqual(rolled);
    expect(rolled.loot).toEqual({ gold: 0, dust: 0, spheres: [], dice: [] });
    expect(JSON.stringify(rolled)).not.toMatch(
      /battleSeed|"seed"|stepIndex|ownerId|telegramUserId/,
    );
  });
  it('awards boss loot once, unlocks the next level, and does not auto-insert or auto-equip a die', async () => {
    await unlocked();
    const result = await finish(await normal());
    expect(result.status).toBe('VICTORY');
    expect(result.reward!.dice!.length).toBeGreaterThanOrEqual(1);
    expect(result.reward!.spheres!.length).toBeGreaterThanOrEqual(1);
    expect(await profile()).toMatchObject({
      highestExpeditionLevel: 1,
      equippedDieId: starter,
      storedVigor: 2,
    });
    expect(await h.db.die.count({ where: { ownerId: owner } })).toBe(1);
    expect(await h.db.pendingDrop.count({ where: { ownerId: owner } })).toBe(
      result.reward!.dice!.length,
    );
    const snapshot = await h.inventory.current(room, alice, NOW);
    expect(snapshot.hub.inventory.pendingDrops).toHaveLength(result.reward!.dice!.length);
    expect(await h.game.current(room, alice)).toEqual(result);
    await expect(normal(snapshot.hub.player.inventoryRevision, 2)).rejects.toMatchObject({
      code: 'UNCLAIMED_DROPS',
    });
  });
  it('settles each currency and a fixed 40-percent subset of found dice on retreat, with exact replay', async () => {
    await unlocked();
    const run = await normal();
    const loot = await injectLoot(run);
    const saved = await h.db.mapRun.findUniqueOrThrow({ where: { id: run.id } });
    let counter = 0;
    const expected = settleExpeditionLoot(expeditionLootSchema.parse(loot), false, (max) =>
      secretInt(saved.seed, 'settlement', counter++, max),
    );
    const key = randomUUID();
    const settled = await retreat(run, key);
    expect(settled.reward).toMatchObject({
      gold: 40,
      dust: 4,
      spheres: [{ type: 'CASTING', amount: 2 }],
    });
    expect(settled.reward!.dice!.map((d) => d.id)).toEqual(expected.dice.map((d) => d.id));
    expect(await retreat(run, key)).toEqual(settled);
    expect(await profile()).toMatchObject({
      gold: 190,
      facetDust: 4,
      highestExpeditionLevel: 0,
      inventoryRevision: 2,
    });
    expect(await h.db.pendingDrop.count()).toBe(2);
    expect(await h.db.die.count()).toBe(1);
  });
  it('actual battle defeat uses the same settlement, never refunds entry vigor or unlocks a level', async () => {
    await unlocked();
    let run = await normal();
    run = await game({
      type: 'STEP',
      runId: run.id,
      nodeId: run.availableNodeIds[0]!,
      expectedRevision: run.revision,
    });
    await injectLoot(run);
    await h.db.mapRun.update({ where: { id: run.id }, data: { playerHp: 1 } });
    await h.db.battle.update({
      where: { id: run.battle!.id },
      data: { state: 'AWAITING_DECISION', currentRolledFace: 5 },
    });
    const defeated = await game({
      type: 'DECISION',
      runId: run.id,
      battleId: run.battle!.id,
      expectedRevision: run.revision,
      action: 'DIRECT',
    });
    expect(defeated.status).toBe('DEFEAT');
    expect(defeated.reward!.dice).toHaveLength(2);
    expect(await profile()).toMatchObject({ storedVigor: 2, highestExpeditionLevel: 0 });
  });
  it('a settlement rollback cannot partially grant dice, spheres or wallet balances', async () => {
    await unlocked();
    const run = await normal();
    await injectLoot(run);
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT test_reject CHECK (false) NOT VALID',
    );
    try {
      await expect(retreat(run)).rejects.toThrow();
      expect(await profile()).toMatchObject({
        gold: 150,
        facetDust: 0,
        storedVigor: 2,
        inventoryRevision: 1,
      });
      expect(await h.db.pendingDrop.count()).toBe(0);
      expect((await h.db.mapRun.findUniqueOrThrow({ where: { id: run.id } })).status).toBe(
        'IN_PROGRESS',
      );
      expect(
        (
          await h.db.userCurrency.findUniqueOrThrow({
            where: { ownerId_sphereType: { ownerId: owner, sphereType: 'CASTING' } },
          })
        ).amount,
      ).toBe(3);
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT test_reject');
    }
  });
  it('signed HTTP has the same start cost/replay and cannot forge level, mode or loot', async () => {
    await unlocked();
    const app = await buildApp({
      profiles: h.profiles,
      game: h.game,
      inventory: h.inventory,
      membership: { assertMember: async () => {} },
      botToken: TEST_TOKEN,
      clock: () => NOW,
      logLevel: false,
    });
    try {
      const headers = { authorization: `tma ${signedInitData()}`, 'idempotency-key': randomUUID() };
      const payload = { level: 1, expectedInventoryRevision: 0, confirmed: true };
      const first = await app.inject({
        method: 'POST',
        url: '/api/expedition/start',
        headers,
        payload,
      });
      expect(first.statusCode).toBe(200);
      expect(
        (
          await app.inject({ method: 'POST', url: '/api/expedition/start', headers, payload })
        ).json(),
      ).toEqual(first.json());
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/expedition/start',
            headers: { ...headers, 'idempotency-key': randomUUID() },
            payload: { ...payload, vigorCost: 0 },
          })
        ).statusCode,
      ).toBe(400);
      expect((await profile()).storedVigor).toBe(2);
    } finally {
      await app.close();
    }
  });
});

describe('bounded pending loot and explicit claims', () => {
  it('full bags preserve all pending drops; rejected claims do not destroy them', async () => {
    const drops = await awardPending();
    await fillBag();
    const snap = await h.inventory.current(room, alice, NOW);
    expect(snap.hub.inventory.pendingDrops.every((d) => !d.take.allowed)).toBe(true);
    await expect(
      inventory({
        type: 'CLAIM_DROP',
        dropId: drops[0]!.id,
        expectedRevision: 2,
        action: 'TAKE',
        confirmed: true,
      }),
    ).rejects.toMatchObject({ code: 'INVENTORY_FULL' });
    expect(await h.db.pendingDrop.count()).toBe(2);
    expect((await profile()).inventoryRevision).toBe(2);
    expect(await h.db.die.count()).toBe(12);
  });
  it('a successful claim is idempotent and restores exactly the generated die', async () => {
    const drop = (await awardPending())[0]!;
    const key = randomUUID();
    const command = {
      type: 'CLAIM_DROP' as const,
      dropId: drop.id,
      expectedRevision: 2,
      action: 'TAKE' as const,
      confirmed: true as const,
    };
    const result = await inventory(command, key);
    expect(await inventory(command, key)).toEqual(result);
    expect(await h.db.die.count()).toBe(2);
    expect(await h.db.pendingDrop.count()).toBe(1);
    expect(result.inventory.hub.inventory.dice.find((d) => d.id === drop.id)).toMatchObject({
      ...(drop.dieData as object),
      isStarter: false,
      isEquipped: false,
    });
    await expect(inventory({ ...command, action: 'DUST' }, key)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
  });
  it('concurrent claims for the last slot cannot bypass capacity or lose the losing drop', async () => {
    const drops = await awardPending();
    await fillBag();
    const extra = await h.db.die.findFirstOrThrow({ where: { ownerId: owner, isStarter: false } });
    await h.db.die.delete({ where: { id: extra.id } });
    const second = new PrismaInventoryRepository(h.db);
    const bodies = drops.map((d) => ({
      type: 'CLAIM_DROP' as const,
      dropId: d.id,
      expectedRevision: 2,
      action: 'TAKE' as const,
      confirmed: true as const,
    }));
    const result = await Promise.allSettled([
      inventory(bodies[0]!),
      second.execute(room, alice, bodies[1]!, randomUUID(), NOW),
    ]);
    expect(result.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.db.die.count()).toBe(12);
    expect(await h.db.pendingDrop.count()).toBe(1);
  });
  it('explicit salvage credits dust once even while all twelve slots are occupied', async () => {
    const drop = (await awardPending())[0]!;
    await fillBag();
    const key = randomUUID(),
      body = {
        type: 'CLAIM_DROP' as const,
        dropId: drop.id,
        expectedRevision: 2,
        action: 'DUST' as const,
        confirmed: true as const,
      };
    const before = (await profile()).facetDust;
    const result = await inventory(body, key);
    expect(result.result).toMatchObject({ type: 'SALVAGE_DROP', dust: 1 });
    await inventory(body, key);
    expect((await profile()).facetDust).toBe(before + 1);
    expect(await h.db.die.count()).toBe(12);
    expect(await h.db.pendingDrop.count()).toBe(1);
  });
  it('rejects cross-user and cross-room drop IDs without changing either balance', async () => {
    const drop = (await awardPending())[0]!;
    const bob = { id: 99, firstName: 'Боб', username: null };
    const otherRoom = await h.rooms.ensureRoom(-1009876543210n, 'Другая', 'r_other000');
    for (const [r, user] of [
      [room, bob],
      [otherRoom, alice],
    ] as const) {
      await h.profiles.openSession(r, user, NOW);
      await expect(
        h.inventory.execute(
          r,
          user,
          {
            type: 'CLAIM_DROP',
            dropId: drop.id,
            expectedRevision: 0,
            action: 'TAKE',
            confirmed: true,
          },
          randomUUID(),
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'DROP_NOT_FOUND' });
    }
    expect(await h.db.pendingDrop.count()).toBe(2);
  });
  it('claim rollback restores the pending item, slot and revision', async () => {
    const drop = (await awardPending())[0]!;
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT test_reject CHECK (false) NOT VALID',
    );
    try {
      await expect(
        inventory({
          type: 'CLAIM_DROP',
          dropId: drop.id,
          expectedRevision: 2,
          action: 'TAKE',
          confirmed: true,
        }),
      ).rejects.toThrow();
      expect(await h.db.pendingDrop.count()).toBe(2);
      expect(await h.db.die.count()).toBe(1);
      expect((await profile()).inventoryRevision).toBe(2);
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT test_reject');
    }
  });
  it('clears the queue deliberately before allowing another normal expedition; training is still available', async () => {
    const drops = await awardPending();
    await expect(normal(2)).rejects.toMatchObject({ code: 'UNCLAIMED_DROPS' });
    const training = await game({ type: 'START' });
    await retreat(training);
    let revision = 3;
    for (const drop of drops) {
      await inventory({
        type: 'CLAIM_DROP',
        dropId: drop.id,
        expectedRevision: revision++,
        action: 'DUST',
        confirmed: true,
      });
    }
    await normal(revision);
    expect((await profile()).storedVigor).toBe(1);
  });
});
