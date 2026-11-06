import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RoomContext, RunDTO } from '@dicebound/shared-types';
import { createDatabase, PrismaGameRepository } from '../src/index.js';
import type { GameCommand } from '../src/index.js';
import { battleFace } from '../src/random.js';
import { databaseHarness } from './harness.js';
import type { DatabaseHarness } from './harness.js';
import { buildApp } from '../../../apps/api/src/app.js';
import { NOW, signedInitData, TEST_TOKEN } from '../../../tests/fixtures.js';
let h: DatabaseHarness;
let room: RoomContext;
let memberId: string;
const alice = { id: 42, firstName: 'Алиса', username: 'alice' };
const bob = { id: 43, firstName: 'Боб', username: null };
beforeAll(async () => {
  h = await databaseHarness();
});
beforeEach(async () => {
  await h.reset();
  room = await h.rooms.ensureRoom(-1001234567890n, 'Обитель', 'r_abcdefgh');
  memberId = (await h.profiles.openSession(room, alice, NOW)).player.id;
});
afterAll(async () => {
  await h?.close();
});
const exec = (command: GameCommand, key = randomUUID(), now = NOW) =>
  h.game.execute(room, alice, command, key, now);
const start = () => exec({ type: 'START' });
const next = (run: RunDTO, nodeId = run.availableNodeIds[0]!) =>
  exec({ type: 'STEP', runId: run.id, expectedRevision: run.revision, nodeId });
const roll = (run: RunDTO, key = randomUUID()) =>
  exec(
    { type: 'ROLL', runId: run.id, battleId: run.battle!.id, expectedRevision: run.revision },
    key,
  );
const decision = (
  run: RunDTO,
  action: 'DIRECT' | 'SHIFT' | 'FLIP' | 'REROLL' = 'DIRECT',
  key = randomUUID(),
) =>
  exec(
    {
      type: 'DECISION',
      runId: run.id,
      battleId: run.battle!.id,
      expectedRevision: run.revision,
      action,
    },
    key,
  );
const retreat = (run: RunDTO, key = randomUUID()) =>
  exec({ type: 'RETREAT', runId: run.id, expectedRevision: run.revision }, key);
async function forceFace(run: RunDTO, face: number) {
  const battle = await h.db.battle.findUniqueOrThrow({ where: { id: run.battle!.id } });
  for (let i = 0; i < 1000; i++) {
    const seed = createHash('sha256').update(`fixture:${i}`).digest('hex');
    if (battleFace(seed, battle.stepIndex) === face) {
      await h.db.battle.update({ where: { id: battle.id }, data: { battleSeed: seed } });
      return;
    }
  }
  throw new Error('No fixture seed found');
}
async function win(run: RunDTO) {
  await h.db.battle.update({ where: { id: run.battle!.id }, data: { enemyHp: 1 } });
  await forceFace(run, 1);
  return decision(await roll(run));
}
describe('PostgreSQL training and battle transactions', () => {
  it('starts one free snapshotted run under twenty simultaneous identical requests', async () => {
    const key = randomUUID();
    const runs = await Promise.all(Array.from({ length: 20 }, () => exec({ type: 'START' }, key)));
    for (const run of runs) expect(run).toEqual(runs[0]);
    expect(runs[0]).toMatchObject({
      revision: 0,
      mode: 'TRAINING',
      playerHp: 50,
      playerMaxHp: 50,
      loot: { gold: 0, dust: 0 },
      availableNodeIds: ['f1-0'],
    });
    expect(await h.db.mapRun.count()).toBe(1);
    expect(await h.db.idempotencyRecord.count()).toBe(1);
    expect(await h.db.roomMember.findUnique({ where: { id: memberId } })).toMatchObject({
      gold: 150,
      storedVigor: 3,
      facetDust: 0,
    });
    expect(await h.db.die.count()).toBe(1);
    expect(await h.db.userCurrency.count()).toBe(6);
  });
  it('different concurrent start keys still produce only one active run', async () => {
    const outcomes = await Promise.allSettled([start(), start()]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await h.db.mapRun.count()).toBe(1);
  });
  it('requires a profile, never creates one through game endpoints', async () => {
    await expect(h.game.current(room, bob)).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    await expect(
      h.game.execute(room, bob, { type: 'START' }, randomUUID(), NOW),
    ).rejects.toMatchObject({ code: 'SESSION_REQUIRED' });
    expect(await h.db.roomMember.count()).toBe(1);
  });
  it('only adjacent unresolved nodes are reachable and an active battle blocks movement', async () => {
    const run = await start();
    await expect(next(run, 'f7-0')).rejects.toMatchObject({ code: 'NODE_NOT_REACHABLE' });
    const entered = await next(run);
    await expect(next(entered, 'f2-0')).rejects.toMatchObject({ code: 'BATTLE_IN_PROGRESS' });
    expect(await h.game.current(room, alice)).toEqual(entered);
  });
  it('serializes roll commands from two service instances with the same saved face after reload', async () => {
    const run = await next(await start());
    await forceFace(run, 3);
    const replicaDb = createDatabase(h.url);
    const replica = new PrismaGameRepository(replicaDb);
    const key = randomUUID();
    try {
      const command = {
        type: 'ROLL' as const,
        runId: run.id,
        battleId: run.battle!.id,
        expectedRevision: run.revision,
      };
      const responses = await Promise.all([
        exec(command, key),
        replica.execute(room, alice, command, key, NOW),
      ]);
      expect(responses[0]).toEqual(responses[1]);
      expect(await replica.current(room, alice)).toEqual(responses[0]);
      expect(responses[0]!.battle).toMatchObject({
        state: 'AWAITING_DECISION',
        currentRolledFace: 3,
        enemyHp: 12,
        playerHp: 50,
        focusCharges: 0,
      });
      const saved = await h.db.battle.findUniqueOrThrow({ where: { id: run.battle!.id } });
      expect(saved.stepIndex).toBe(1);
      const body = JSON.stringify(responses[0]);
      for (const secret of [
        'seed',
        'battleSeed',
        'stepIndex',
        'telegramUserId',
        'ownerId',
        saved.battleSeed,
      ])
        expect(body).not.toContain(secret);
    } finally {
      await replicaDb.$disconnect();
    }
  });
  it('different roll nonces cannot bypass the expected revision or roll phase', async () => {
    const run = await next(await start());
    const results = await Promise.allSettled([roll(run), roll(run)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const current = (await h.game.current(room, alice))!;
    await expect(roll(current)).rejects.toMatchObject({ code: 'ROLL_NOT_ALLOWED' });
    expect((await h.db.battle.findUniqueOrThrow({ where: { id: run.battle!.id } })).stepIndex).toBe(
      1,
    );
  });
  it('commits an action once; direct/flip do not consume extra RNG steps', async () => {
    const run = await next(await start());
    await forceFace(run, 1);
    let rolled = await roll(run);
    const key = randomUUID();
    const command = {
      type: 'DECISION' as const,
      runId: run.id,
      battleId: run.battle!.id,
      expectedRevision: rolled.revision,
      action: 'DIRECT' as const,
    };
    const [a, b] = await Promise.all([exec(command, key), exec(command, key)]);
    expect(a).toEqual(b);
    expect(a.battle).toMatchObject({ focusCharges: 1, playerHp: 47, enemyHp: 8, turnNumber: 2 });
    await expect(decision(rolled)).rejects.toMatchObject({ code: 'STALE_STATE' });
    await forceFace(a, 1);
    rolled = await roll(a);
    const flipped = await decision(rolled, 'FLIP');
    expect(flipped.battle).toMatchObject({
      focusCharges: 0,
      turnNumber: 3,
      state: 'AWAITING_ROLL',
    });
    expect((await h.db.battle.findUniqueOrThrow({ where: { id: run.battle!.id } })).stepIndex).toBe(
      2,
    );
  });
  it('reroll consumes precisely one charge/counter and cannot be repeated after reload', async () => {
    let run = await next(await start());
    run = await roll(run);
    const key = randomUUID();
    const result = await decision(run, 'REROLL', key);
    expect(await decision(run, 'REROLL', key)).toEqual(result);
    expect(await h.game.current(room, alice)).toEqual(result);
    expect(result.battle).toMatchObject({
      rerollsLeft: 0,
      state: 'AWAITING_DECISION',
      turnNumber: 1,
      playerHp: 50,
      focusCharges: 0,
    });
    await expect(decision(result, 'REROLL')).rejects.toMatchObject({ code: 'NO_REROLLS' });
    expect((await h.db.battle.findUniqueOrThrow({ where: { id: run.battle!.id } })).stepIndex).toBe(
      2,
    );
  });
  it('same key with changed payload or operation is a conflict, including after completion', async () => {
    const key = randomUUID();
    const run = await exec({ type: 'START' }, key);
    await expect(
      exec({ type: 'STEP', runId: run.id, expectedRevision: 0, nodeId: 'f1-0' }, key),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    const done = await retreat(run);
    expect(await exec({ type: 'START' }, key)).toEqual(run);
    expect(await h.game.current(room, alice)).toEqual(done);
    expect(await h.db.mapRun.count()).toBe(1);
  });
  it('rejects replay after TTL and keeps compact nonce tombstones instead of executing again', async () => {
    const key = randomUUID();
    const run = await exec({ type: 'START' }, key);
    await retreat(run);
    const later = new Date(NOW.getTime() + 86_400_001);
    await expect(exec({ type: 'START' }, key, later)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_EXPIRED',
    });
    await exec({ type: 'START' }, randomUUID(), later);
    expect(
      (
        await h.db.idempotencyRecord.findUniqueOrThrow({
          where: { memberId_key: { memberId, key } },
        })
      ).responseBody,
    ).toEqual({ expired: true });
    await expect(exec({ type: 'START' }, key, later)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_EXPIRED',
    });
    await expect(exec({ type: 'START' }, key, NOW)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_EXPIRED',
    });
    expect(await h.db.mapRun.count()).toBe(2);
  });
  it('scopes ownership and nonces to signed member and room, with no cross-chat data', async () => {
    const key = randomUUID();
    const run = await exec({ type: 'START' }, key);
    await h.profiles.openSession(room, bob, NOW);
    const other = await h.rooms.ensureRoom(-100999n, 'Другая', 'r_ijklmnop');
    await h.profiles.openSession(other, alice, NOW);
    for (const [context, identity] of [
      [room, bob],
      [other, alice],
    ] as const) {
      await expect(
        h.game.execute(
          context,
          identity,
          { type: 'STEP', runId: run.id, nodeId: 'f1-0', expectedRevision: 0 },
          randomUUID(),
          NOW,
        ),
      ).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });
      expect(await h.game.current(context, identity)).toBeNull();
      const own = await h.game.execute(context, identity, { type: 'START' }, key, NOW);
      expect(own.id).not.toBe(run.id);
    }
  });
  it('freezes equipped die values and records victorious PS from the snapshot', async () => {
    const run = await start();
    await h.db.die.update({ where: { id: run.loadout.id }, data: { quality: 20, powerScore: 99 } });
    const entered = await next(run);
    await forceFace(entered, 1);
    const rolled = await roll(entered);
    expect(rolled.loadout.quality).toBe(0);
    expect(rolled.battle?.options?.direct.value).toBe(4);
    await h.db.battle.update({ where: { id: entered.battle!.id }, data: { enemyHp: 1 } });
    await decision(rolled);
    expect(await h.db.die.findUnique({ where: { id: run.loadout.id } })).toMatchObject({
      lastVictoryPowerScore: 55,
      lastVictoryAt: NOW,
      powerScore: 99,
    });
  });
  it('opens a chest once, heals at camp, and does not credit pending loot early', async () => {
    let run = await win(await next(await start()));
    const chest = run.nodes.find((n) => n.depth === 2 && n.type === 'CHEST')!;
    const key = randomUUID();
    const command = {
      type: 'STEP' as const,
      runId: run.id,
      nodeId: chest.id,
      expectedRevision: run.revision,
    };
    const [a, b] = await Promise.all([exec(command, key), exec(command, key)]);
    expect(a).toEqual(b);
    run = a;
    expect(run.loot).toEqual({ gold: 7, dust: 2 });
    expect(await h.db.roomMember.findUnique({ where: { id: memberId } })).toMatchObject({
      gold: 150,
      facetDust: 0,
      storedVigor: 3,
    });
    await h.db.mapRun.update({ where: { id: run.id }, data: { playerHp: 20 } });
    run = await next(run, run.nodes.find((n) => n.depth === 3 && n.type === 'CAMP')!.id);
    expect(run.playerHp).toBe(38);
    await expect(next(run, chest.id)).rejects.toMatchObject({ code: 'NODE_NOT_REACHABLE' });
  });
  it('retreat settles floor 40% exactly once, terminates the saved battle and allows another run', async () => {
    const run = await roll(await next(await start()));
    await h.db.mapRun.update({
      where: { id: run.id },
      data: { accumulatedLoot: { gold: 11, dust: 3 } },
    });
    const key = randomUUID();
    const [a, b] = await Promise.all([retreat(run, key), retreat(run, key)]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({
      status: 'DEFEAT',
      reward: { gold: 4, dust: 1 },
      battle: { state: 'FINISHED', outcome: 'DEFEAT', currentRolledFace: null },
    });
    expect(await h.db.roomMember.findUnique({ where: { id: memberId } })).toMatchObject({
      gold: 154,
      facetDust: 1,
      storedVigor: 3,
    });
    await expect(retreat(run)).rejects.toMatchObject({ code: 'RUN_FINISHED' });
    const fresh = await start();
    expect(await retreat(run, key)).toEqual(a);
    expect((await h.game.current(room, alice))?.id).toBe(fresh.id);
  });
  it('defeat credits salvage once and never records a victorious use', async () => {
    let run = await next(await start());
    await forceFace(run, 1);
    await h.db.mapRun.update({
      where: { id: run.id },
      data: { playerHp: 1, accumulatedLoot: { gold: 11, dust: 3 } },
    });
    run = await roll(run);
    const key = randomUUID();
    const done = await decision(run, 'DIRECT', key);
    expect(await decision(run, 'DIRECT', key)).toEqual(done);
    expect(done).toMatchObject({ status: 'DEFEAT', playerHp: 0, reward: { gold: 4, dust: 1 } });
    expect(await h.db.roomMember.findUnique({ where: { id: memberId } })).toMatchObject({
      gold: 154,
      facetDust: 1,
    });
    expect(
      (await h.db.die.findUniqueOrThrow({ where: { id: run.loadout.id } })).lastVictoryAt,
    ).toBeNull();
  });
  it('a completed seven-depth route settles 100% gold/dust without granting items or consuming vigor', async () => {
    let run = await start();
    for (let depth = 1; depth <= 7; depth++) {
      const candidates = run.nodes.filter((n) => run.availableNodeIds.includes(n.id));
      const choice =
        candidates.find((n) => n.type === 'CHEST') ??
        candidates.find((n) => n.type === 'CAMP') ??
        candidates[0]!;
      run = await next(run, choice.id);
      if (run.battle?.state !== 'FINISHED' && run.battle) run = await win(run);
    }
    expect(run.status).toBe('VICTORY');
    expect(run.reward).toEqual(run.loot);
    expect(run.loot).toEqual({ gold: 25, dust: 7 });
    expect(run.visitedNodeIds).toHaveLength(8);
    expect(await h.db.roomMember.findUnique({ where: { id: memberId } })).toMatchObject({
      gold: 175,
      facetDust: 7,
      storedVigor: 3,
    });
    expect(await h.db.die.count()).toBe(1);
    expect((await h.db.userCurrency.findMany()).reduce((sum, row) => sum + row.amount, 0)).toBe(6);
    expect((await h.db.mapRun.findUniqueOrThrow({ where: { id: run.id } })).lootSettledAt).toEqual(
      NOW,
    );
  });
  it('rolls back HP/revision/RNG when writing the idempotent response fails', async () => {
    const run = await next(await start());
    await forceFace(run, 3);
    const key = randomUUID();
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "test_fail_cache" CHECK (false) NOT VALID',
    );
    try {
      await expect(roll(run, key)).rejects.toThrow();
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "test_fail_cache"');
    }
    expect(await h.game.current(room, alice)).toEqual(run);
    expect((await h.db.battle.findUniqueOrThrow({ where: { id: run.battle!.id } })).stepIndex).toBe(
      0,
    );
    expect((await roll(run, key)).battle?.currentRolledFace).toBe(3);
  });
  it('rolls back the wallet and terminal state when settlement response storage fails', async () => {
    const run = await roll(await next(await start()));
    const key = randomUUID();
    await h.db.mapRun.update({
      where: { id: run.id },
      data: { accumulatedLoot: { gold: 11, dust: 3 } },
    });
    await h.admin.query(
      'ALTER TABLE "IdempotencyRecord" ADD CONSTRAINT "test_fail_settlement" CHECK (false) NOT VALID',
    );
    try {
      await expect(retreat(run, key)).rejects.toThrow();
    } finally {
      await h.admin.query('ALTER TABLE "IdempotencyRecord" DROP CONSTRAINT "test_fail_settlement"');
    }
    expect(await h.game.current(room, alice)).toMatchObject({
      status: 'IN_PROGRESS',
      revision: run.revision,
      reward: null,
      battle: { state: 'AWAITING_DECISION' },
    });
    expect(await h.db.roomMember.findUnique({ where: { id: memberId } })).toMatchObject({
      gold: 150,
      facetDust: 0,
    });
    expect((await retreat(run, key)).reward).toEqual({ gold: 4, dust: 1 });
  });
  it('rejects a foreign battle ID even when the supplied run is owned', async () => {
    const own = await next(await start());
    await h.profiles.openSession(room, bob, NOW);
    let other = await h.game.execute(room, bob, { type: 'START' }, randomUUID(), NOW);
    other = await h.game.execute(
      room,
      bob,
      { type: 'STEP', runId: other.id, expectedRevision: 0, nodeId: 'f1-0' },
      randomUUID(),
      NOW,
    );
    await expect(
      exec({
        type: 'ROLL',
        runId: own.id,
        expectedRevision: own.revision,
        battleId: other.battle!.id,
      }),
    ).rejects.toMatchObject({ code: 'BATTLE_NOT_FOUND' });
  });
  it('executes signed HTTP routes against PostgreSQL and restores the exact roll after API restart', async () => {
    let time = NOW;
    const deps = {
      profiles: h.profiles,
      game: h.game,
      membership: { assertMember: async () => undefined },
      botToken: TEST_TOKEN,
      clock: () => time,
      logLevel: false as const,
    };
    const app = await buildApp(deps);
    let saved: RunDTO;
    try {
      const auth = { authorization: `tma ${signedInitData()}` };
      const post = async (url: string, payload: object, key = randomUUID()) => {
        time = new Date(time.getTime() + 1100);
        return app.inject({
          method: 'POST',
          url,
          payload,
          headers: { ...auth, 'idempotency-key': key },
        });
      };
      const begun = await post('/api/map/start', {});
      expect(begun.statusCode).toBe(200);
      let run = begun.json<{ run: RunDTO }>().run;
      const entered = await post('/api/map/step', {
        runId: run.id,
        expectedRevision: 0,
        nodeId: 'f1-0',
      });
      expect(entered.statusCode).toBe(200);
      run = entered.json<{ run: RunDTO }>().run;
      const body = { runId: run.id, battleId: run.battle!.id, expectedRevision: run.revision };
      const key = randomUUID();
      const rolled = await post('/api/battle/roll', body, key);
      expect(rolled.statusCode).toBe(200);
      saved = rolled.json<{ run: RunDTO }>().run;
      const replay = await post('/api/battle/roll', body, key);
      expect(replay.json()).toEqual(rolled.json());
      expect(
        (
          await post('/api/battle/decision', {
            ...body,
            expectedRevision: saved.revision,
            action: 'DIRECT',
            face: 6,
          })
        ).statusCode,
      ).toBe(400);
      expect(rolled.body).not.toContain('Seed');
      expect(rolled.body).not.toContain('stepIndex');
    } finally {
      await app.close();
    }
    const restored = await buildApp({ ...deps, game: new PrismaGameRepository(h.db) });
    try {
      const result = await restored.inject({
        url: '/api/map/current',
        headers: { authorization: `tma ${signedInitData()}` },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().run).toEqual(saved!);
    } finally {
      await restored.close();
    }
  });

  it('enforces dust, revision, completion, and battle-outcome invariants in SQL', async () => {
    const run = await next(await start());
    await expect(
      h.db.roomMember.update({ where: { id: memberId }, data: { facetDust: -1 } }),
    ).rejects.toThrow();
    await expect(
      h.db.mapRun.update({ where: { id: run.id }, data: { revision: -1 } }),
    ).rejects.toThrow();
    await expect(
      h.db.mapRun.update({ where: { id: run.id }, data: { status: 'DEFEAT', completedAt: NOW } }),
    ).rejects.toThrow();
    await expect(
      h.db.mapRun.update({
        where: { id: run.id },
        data: { settledLoot: { gold: 1, dust: 1 }, lootSettledAt: NOW },
      }),
    ).rejects.toThrow();
    await expect(
      h.db.mapRun.update({ where: { id: run.id }, data: { completedAt: NOW } }),
    ).rejects.toThrow();
    await expect(
      h.db.battle.update({ where: { id: run.battle!.id }, data: { state: 'FINISHED' } }),
    ).rejects.toThrow();
    await expect(
      h.db.battle.update({ where: { id: run.battle!.id }, data: { outcome: 'VICTORY' } }),
    ).rejects.toThrow();
    expect(await h.game.current(room, alice)).toEqual(run);
  });
});
