import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RoomContext } from '@dicebound/shared-types';
import { DAILY_HORNS, RAID_ROUNDS, SEAL_TARGET, raidMaxHp } from '@dicebound/game-core';
import type { RaidCommand } from '../src/index.js';
import { databaseHarness } from './harness.js';
import type { DatabaseHarness } from './harness.js';

const NOW = new Date('2026-11-05T09:00:00Z');
const alice = { id: 42, firstName: 'Алиса', username: 'alice' };

describe('Рейд Обители', () => {
  let h: DatabaseHarness, room: RoomContext, memberId: string;

  const raid = (command: RaidCommand, key = randomUUID(), now = NOW) =>
    h.raid.execute(room, alice, command, key, now);

  /** Фрагменты печати в бою даёт победа над боссом обычной экспедиции. */
  const grantFragments = (count: number) =>
    h.db.roomMember.update({
      where: { id: memberId },
      data: { sealFragments: count },
    });

  const fillAltar = async () => {
    await grantFragments(SEAL_TARGET);
    for (let index = 0; index < SEAL_TARGET; index++)
      await raid({ type: 'CONTRIBUTE', fragments: 1, expectedRevision: 0, confirmed: true });
  };

  const summon = async () => {
    await fillAltar();
    return raid({ type: 'SUMMON', expectedRevision: 0, confirmed: true });
  };

  beforeAll(async () => {
    h = await databaseHarness();
  });
  beforeEach(async () => {
    await h.reset();
    room = await h.rooms.ensureRoom(-1009876543210n, 'Обитель', 'r_raidtest');
    const hub = await h.profiles.openSession(room, alice, NOW);
    memberId = hub.player.id;
  });
  afterAll(async () => {
    await h?.close();
  });

  it('не даёт призвать рейд до сбора алтаря и не берёт вклад без фрагментов', async () => {
    const before = await h.raid.current(room, alice, NOW);
    expect(before.altar).toMatchObject({ fragments: 0, target: SEAL_TARGET, ready: false });
    expect(before.raid).toBeNull();
    expect(before.canSummon).toMatchObject({ allowed: false });
    expect(before.canContribute.allowed).toBe(false);
    expect(before.myFragments).toBe(0);
    await expect(
      raid({ type: 'SUMMON', expectedRevision: 0, confirmed: true }),
    ).rejects.toMatchObject({ code: 'SEAL_INCOMPLETE' });
    await expect(
      raid({ type: 'CONTRIBUTE', fragments: 1, expectedRevision: 0, confirmed: true }),
    ).rejects.toMatchObject({ code: 'FRAGMENTS_MISSING' });
  });

  it('переносит фрагменты в алтарь и не позволяет превысить цель печати', async () => {
    await grantFragments(SEAL_TARGET + 4);
    const contributed = await raid({
      type: 'CONTRIBUTE',
      fragments: SEAL_TARGET + 4,
      expectedRevision: 0,
      confirmed: true,
    });
    // Алтарь принимает ровно цель, остаток остаётся у участника.
    expect(contributed.altar).toMatchObject({ fragments: SEAL_TARGET, ready: true });
    expect(contributed.myFragments).toBe(4);
    expect(contributed.canContribute.allowed).toBe(false);
    await expect(
      raid({ type: 'CONTRIBUTE', fragments: 1, expectedRevision: 0, confirmed: true }),
    ).rejects.toMatchObject({ code: 'ALTAR_FULL' });
    // Неподтверждённый вклад отклоняется без списания.
    await expect(
      raid({
        type: 'CONTRIBUTE',
        fragments: 1,
        expectedRevision: 0,
        confirmed: false as never,
      }),
    ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
    expect((await h.raid.current(room, alice, NOW)).myFragments).toBe(4);
  });

  it('призывает рейд, очищает алтарь и ставит событие в очередь анонсов', async () => {
    const summoned = await summon();
    expect(summoned.raid).toMatchObject({
      status: 'ACTIVE',
      phase: 1,
      maxHp: raidMaxHp(1),
      shield: 1,
      revision: 0,
    });
    expect(summoned.raid!.rounds).toHaveLength(RAID_ROUNDS);
    expect(summoned.raid!.rounds.map((round) => round.shield)).toEqual([1, 1, 2, 2, 3, 3]);
    expect(summoned.raid!.rounds.every((round) => !round.cleared)).toBe(true);
    expect(summoned.hornsLeft).toBe(DAILY_HORNS);
    expect(summoned.myFragments).toBe(0);
    // Призыв расходует печать: второй рейд требует нового сбора.
    const after = await h.raid.current(room, alice, NOW);
    expect(after.altar.fragments).toBe(0);
    expect(after.canSummon).toMatchObject({ allowed: false });
    await expect(
      raid({ type: 'SUMMON', expectedRevision: 0, confirmed: true }),
    ).rejects.toMatchObject({ code: 'SEAL_INCOMPLETE' });
    const events = await h.db.gameEvent.findMany({ where: { roomId: room.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'RAID_SUMMONED', sentAt: null, attempts: 0 });
    expect(events[0]!.dedupKey).toBe(`raid:${summoned.raid!.id}:summoned`);
  });

  it('проходит все шесть раундов до победы и делит награду по доле урона', async () => {
    // Стартовый кубик содержит грань HEAL, которая не наносит урона рейду и тратит рог
    // впустую: шести рогов соло-Обители на шесть раундов тогда не хватает. Это часть
    // баланса и проверяется отдельно, поэтому здесь снаряд приводится к боевому —
    // как фикстура ускорения в тестах экспедиций, а не подмена правил.
    await h.db.die.updateMany({
      where: { ownerId: memberId },
      data: {
        faces: [
          { face: 1, action: 'STRIKE', value: 9 },
          { face: 2, action: 'STRIKE', value: 9 },
          { face: 3, action: 'STRIKE', value: 9 },
          { face: 4, action: 'STRIKE', value: 9 },
          { face: 5, action: 'STRIKE', value: 9 },
          { face: 6, action: 'STRIKE', value: 9 },
        ],
      },
    });
    const summoned = await summon();
    const raidId = summoned.raid!.id;
    const goldBefore = (await h.db.roomMember.findUniqueOrThrow({ where: { id: memberId } })).gold;
    const dustBefore = (await h.db.roomMember.findUniqueOrThrow({ where: { id: memberId } }))
      .facetDust;
    let state = summoned;
    // Рога восстанавливаются по суткам UTC, поэтому бой растягивается на несколько дней.
    // Окно рейда — 48 часов: держимся внутри него и переносим «сегодня».
    let day = NOW;
    let hornsToday = DAILY_HORNS;
    for (let attack = 0; attack < RAID_ROUNDS + 2 && state.raid!.status === 'ACTIVE'; attack++) {
      if (hornsToday === 0) {
        day = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate() + 1, 9));
        hornsToday = DAILY_HORNS;
      }
      if (!state.raid!.attack) {
        state = await raid(
          { type: 'ATTACK', raidId, expectedRevision: state.raid!.revision },
          randomUUID(),
          day,
        );
        hornsToday--;
      }
      state = await raid(
        {
          type: 'DECIDE',
          raidId,
          attackId: state.raid!.attack!.id,
          expectedRevision: state.raid!.revision,
          action: 'DIRECT',
        },
        randomUUID(),
        day,
      );
    }
    expect(state.raid!.status).toBe('DEFEATED');
    expect(state.raid!.currentHp).toBe(0);
    expect(state.raid!.defeatedAt).not.toBeNull();
    expect(state.raid!.rounds.every((round) => round.cleared)).toBe(true);
    expect(state.raid!.totalDamage).toBeGreaterThan(0);
    expect(state.raid!.contributions).toHaveLength(1);
    expect(state.raid!.contributions[0]).toMatchObject({
      memberId,
      firstName: 'Алиса',
      damage: state.raid!.totalDamage,
    });
    // Победитель получил золото и пыль; награда не пустая.
    const winner = await h.db.roomMember.findUniqueOrThrow({ where: { id: memberId } });
    expect(winner.gold).toBeGreaterThan(goldBefore);
    expect(winner.facetDust).toBeGreaterThan(dustBefore);
    const events = await h.db.gameEvent.findMany({
      where: { roomId: room.id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.eventType)).toEqual(['RAID_SUMMONED', 'RAID_DEFEATED']);
    // По завершённому рейду ударить нельзя.
    await expect(
      raid({ type: 'ATTACK', raidId, expectedRevision: state.raid!.revision }),
    ).rejects.toMatchObject({ code: 'RAID_CLOSED' });
  });

  it('тратит не больше трёх рогов в сутки и не даёт два незавершённых удара', async () => {
    const summoned = await summon();
    const raidId = summoned.raid!.id;
    let revision = summoned.raid!.revision;
    // Первый удар открываем накануне, чтобы суточный лимит не перекрывал проверку
    // «незавершённый удар раньше, чем рога».
    for (let horn = 0; horn < DAILY_HORNS; horn++) {
      const started = await raid(
        { type: 'ATTACK', raidId, expectedRevision: revision },
        randomUUID(),
        new Date(Date.UTC(2026, 10, 5, 9, horn)),
      );
      await expect(
        raid(
          { type: 'ATTACK', raidId, expectedRevision: started.raid!.revision },
          randomUUID(),
          new Date(Date.UTC(2026, 10, 5, 9, horn)),
        ),
      ).rejects.toMatchObject({ code: 'ATTACK_ALREADY_OPEN' });
      const decided = await raid(
        {
          type: 'DECIDE',
          raidId,
          attackId: started.raid!.attack!.id,
          expectedRevision: started.raid!.revision,
          action: 'DIRECT',
        },
        randomUUID(),
        new Date(Date.UTC(2026, 10, 5, 9, horn)),
      );
      revision = decided.raid!.revision;
      expect(decided.hornsLeft).toBe(DAILY_HORNS - horn - 1);
    }
    await expect(
      raid({ type: 'ATTACK', raidId, expectedRevision: revision }),
    ).rejects.toMatchObject({ code: 'HORNS_SPENT' });
    // Следующие сутки по UTC возвращают рога.
    const tomorrow = new Date(Date.UTC(2026, 10, 6, 9));
    const next = await raid(
      { type: 'ATTACK', raidId, expectedRevision: revision },
      randomUUID(),
      tomorrow,
    );
    expect(next.hornsLeft).toBe(DAILY_HORNS - 1);
    expect(next.raid!.attack!.state).toBe('AWAITING_DECISION');
  });

  it('бросает кубик на сервере, даёт один переброс и фиксирует урон решением', async () => {
    const summoned = await summon();
    const raidId = summoned.raid!.id;
    const started = await raid({
      type: 'ATTACK',
      raidId,
      expectedRevision: summoned.raid!.revision,
    });
    const attack = started.raid!.attack!;
    expect(attack.state).toBe('AWAITING_DECISION');
    expect(attack.rollsUsed).toBe(1);
    expect(attack.rerollsLeft).toBe(1);
    expect(attack.currentRolledFace!).toBeGreaterThanOrEqual(1);
    expect(attack.currentRolledFace!).toBeLessThanOrEqual(6);
    expect(attack.options!.direct!.value).toBeGreaterThan(0);
    expect(attack.options!.flip).toBeNull();
    // Урон не нанесён, пока решение не принято.
    expect(started.raid!.currentHp).toBe(started.raid!.roundHp);
    expect(started.raid!.phase).toBe(1);
    const rerolled = await raid({
      type: 'DECIDE',
      raidId,
      attackId: attack.id,
      expectedRevision: started.raid!.revision,
      action: 'REROLL',
    });
    expect(rerolled.raid!.attack).toMatchObject({ rollsUsed: 2, rerollsLeft: 0 });
    expect(rerolled.raid!.currentHp).toBe(rerolled.raid!.roundHp);
    await expect(
      raid({
        type: 'DECIDE',
        raidId,
        attackId: attack.id,
        expectedRevision: rerolled.raid!.revision,
        action: 'REROLL',
      }),
    ).rejects.toMatchObject({ code: 'NO_REROLLS' });
    const resolved = await raid({
      type: 'DECIDE',
      raidId,
      attackId: attack.id,
      expectedRevision: rerolled.raid!.revision,
      action: 'DIRECT',
    });
    expect(resolved.raid!.attack).toBeNull();
    // Выпавшая грань может оказаться HEAL — тогда удар сознательно не наносит урона.
    // Проверяем контракт: решение зафиксировано, атака закрыта, ревизия продвинута.
    expect(resolved.raid!.revision).toBeGreaterThan(rerolled.raid!.revision);
    const progressed =
      resolved.raid!.myDamage > 0 ||
      resolved.raid!.currentHp < resolved.raid!.roundHp ||
      resolved.raid!.phase > started.raid!.phase ||
      resolved.raid!.status === 'DEFEATED';
    expect(progressed).toBe(true);
    const finished = await h.db.raidAttack.findUniqueOrThrow({ where: { id: attack.id } });
    expect(finished.state).toBe('FINISHED');
    expect(finished.finishedAt).not.toBeNull();
    expect(finished.attackSeed).not.toBeNull();
    expect(finished.currentRolledFace).toBeNull();
    expect(['STRIKE', 'GUARD', 'PIERCE', 'HEAL']).toContain(finished.action);
    expect(finished.faceValue).toBeGreaterThanOrEqual(0);
    await expect(
      raid({
        type: 'DECIDE',
        raidId,
        attackId: attack.id,
        expectedRevision: resolved.raid!.revision,
        action: 'DIRECT',
      }),
    ).rejects.toMatchObject({ code: 'ATTACK_FINISHED' });
  });

  it('просроченный рейд становится EXPIRED и освобождает Обитель для нового', async () => {
    const summoned = await summon();
    // Рейд живёт 48 часов, поэтому проверяем уже за пределами окна.
    const later = new Date(NOW.getTime() + 48 * 3_600_000 + 60_000);
    const expired = await h.raid.current(room, alice, later);
    expect(expired.raid!.status).toBe('EXPIRED');
    expect(expired.raid!.currentHp).toBe(0);
    expect(expired.canAttack.allowed).toBe(false);
    expect(expired.hornsLeft).toBe(0);
    await expect(
      raid(
        { type: 'ATTACK', raidId: summoned.raid!.id, expectedRevision: expired.raid!.revision },
        randomUUID(),
        later,
      ),
    ).rejects.toMatchObject({ code: 'RAID_CLOSED' });
    // Личные фрагменты сами в алтарь не попадают: Обитель собирает печать заново.
    await grantFragments(SEAL_TARGET);
    for (let index = 0; index < SEAL_TARGET; index++)
      await raid(
        { type: 'CONTRIBUTE', fragments: 1, expectedRevision: 0, confirmed: true },
        randomUUID(),
        later,
      );
    const again = await h.raid.current(room, alice, later);
    expect(again.altar.ready).toBe(true);
    expect(again.canSummon.allowed).toBe(true);
    const resumnmoned = await raid(
      { type: 'SUMMON', expectedRevision: 0, confirmed: true },
      randomUUID(),
      later,
    );
    expect(resumnmoned.raid!.status).toBe('ACTIVE');
    expect(resumnmoned.raid!.id).not.toBe(summoned.raid!.id);
  });

  it('отклоняет устаревшую ревизию рейда и повторяет команду по одному ключу', async () => {
    const summoned = await summon();
    const raidId = summoned.raid!.id;
    await expect(raid({ type: 'ATTACK', raidId, expectedRevision: 999 })).rejects.toMatchObject({
      code: 'STALE_RAID',
    });
    await expect(
      raid({ type: 'ATTACK', raidId: randomUUID(), expectedRevision: 0 }),
    ).rejects.toMatchObject({ code: 'RAID_NOT_FOUND' });
    const key = randomUUID();
    const first = await raid(
      { type: 'ATTACK', raidId, expectedRevision: summoned.raid!.revision },
      key,
    );
    const replay = await raid(
      { type: 'ATTACK', raidId, expectedRevision: summoned.raid!.revision },
      key,
    );
    expect(replay.raid!.attack!.id).toBe(first.raid!.attack!.id);
    expect(await h.db.raidAttack.count({ where: { raidId } })).toBe(1);
  });

  it('требует экипированный кубик для удара', async () => {
    await h.db.roomMember.update({ where: { id: memberId }, data: { equippedDieId: null } });
    const summoned = await summon();
    await expect(
      raid({
        type: 'ATTACK',
        raidId: summoned.raid!.id,
        expectedRevision: summoned.raid!.revision,
      }),
    ).rejects.toMatchObject({ code: 'NO_EQUIPPED_DIE' });
    const view = await h.raid.current(room, alice, NOW);
    expect(view.canAttack).toMatchObject({ allowed: false });
  });

  it('считает рейтинг семи дней только по победным кубикам Обители', async () => {
    const empty = await h.raid.leaderboard(room, alice, NOW);
    expect(empty.entries).toEqual([]);
    expect(empty.windowDays).toBe(7);
    const die = await h.db.die.findFirstOrThrow({ where: { ownerId: memberId } });
    await h.db.die.update({
      where: { id: die.id },
      data: { lastVictoryAt: NOW, lastVictoryPowerScore: die.powerScore },
    });
    const ranked = await h.raid.leaderboard(room, alice, NOW);
    expect(ranked.entries).toHaveLength(1);
    expect(ranked.entries[0]).toMatchObject({
      dieId: die.id,
      ownerName: 'Алиса',
      lastVictoryPowerScore: die.powerScore,
      qualified: true,
    });
    // Старая победа выпадает из зачётного окна.
    const old = await h.raid.leaderboard(room, alice, new Date(NOW.getTime() + 8 * 86_400_000));
    expect(old.entries).toEqual([]);
  });
});
