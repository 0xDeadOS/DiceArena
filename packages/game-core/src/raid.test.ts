import { describe, expect, it } from 'vitest';
import {
  ANNOUNCE_COOLDOWN_HOURS,
  DAILY_HORNS,
  HIGH_PS_ANNOUNCE_AT,
  RAID_DURATION_HOURS,
  RAID_ROUNDS,
  RANKING_WINDOW_DAYS,
  SEAL_TARGET,
  announceCooldownStart,
  hornsLeft,
  raidExpiry,
  raidMaxHp,
  raidReward,
  raidRewardPool,
  raidRoundAfter,
  raidRoundHp,
  raidShield,
  raidStrike,
  rankingWindowStart,
  sealProgress,
} from './index.js';

describe('raid constants and seal progress', () => {
  it('keeps the documented structure of the v2 raid', () => {
    expect(RAID_ROUNDS).toBe(6);
    expect(RAID_DURATION_HOURS).toBe(48);
    expect(DAILY_HORNS).toBe(3);
    expect(SEAL_TARGET).toBe(15);
    expect(RANKING_WINDOW_DAYS).toBe(7);
    expect(ANNOUNCE_COOLDOWN_HOURS).toBe(12);
    expect(HIGH_PS_ANNOUNCE_AT).toBe(90);
  });
  it('clamps the altar to the target and reports readiness exactly at fifteen', () => {
    expect(sealProgress(0)).toEqual({ fragments: 0, ready: false });
    expect(sealProgress(14)).toEqual({ fragments: 14, ready: false });
    expect(sealProgress(15)).toEqual({ fragments: 15, ready: true });
    expect(sealProgress(40)).toEqual({ fragments: 15, ready: true });
    expect(sealProgress(-3)).toEqual({ fragments: 0, ready: false });
  });
  it('scales the boss with the room and derives the total from six rounds', () => {
    expect(raidRoundHp(1)).toBe(2);
    expect(raidRoundHp(5)).toBe(10);
    expect(raidMaxHp(5)).toBe(raidRoundHp(5) * RAID_ROUNDS);
    for (const size of [0, -1, 201, 2.5]) expect(() => raidRoundHp(size)).toThrow();
  });
  it('grows the shield per round and rejects an impossible round', () => {
    expect([1, 2, 3, 4, 5, 6].map(raidShield)).toEqual([1, 1, 2, 2, 3, 3]);
    for (const round of [0, 7, 1.5]) expect(() => raidShield(round)).toThrow();
  });
  it('counts horns left per UTC day and never goes negative', () => {
    expect(hornsLeft(0)).toBe(3);
    expect(hornsLeft(2)).toBe(1);
    expect(hornsLeft(3)).toBe(0);
    expect(hornsLeft(9)).toBe(0);
    expect(hornsLeft(-1)).toBe(3);
  });
  it('derives expiry and both time windows from the summoning moment', () => {
    const now = new Date('2026-11-05T12:00:00.000Z');
    expect(raidExpiry(now).toISOString()).toBe('2026-11-07T12:00:00.000Z');
    expect(rankingWindowStart(now).toISOString()).toBe('2026-10-29T12:00:00.000Z');
    expect(announceCooldownStart(now).toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });
});

describe('raid strike', () => {
  it('applies the action share, the round shield and loses overkill', () => {
    const strike = raidStrike(1, 20, 2, 'STRIKE', 10);
    expect(strike).toEqual({ roundHp: 12, shield: 0, damage: 8, roundCleared: false });
    const healed = raidStrike(1, 20, 0, 'HEAL', 12);
    expect(healed.damage).toBe(0);
    expect(healed.roundHp).toBe(20);
    const guarded = raidStrike(2, 20, 0, 'GUARD', 9);
    expect(guarded.damage).toBe(4);
    const overkill = raidStrike(3, 5, 0, 'STRIKE', 40);
    expect(overkill).toEqual({ roundHp: 0, shield: 0, damage: 5, roundCleared: true });
  });
  it('lets a pierce ignore half of the round shield', () => {
    const plain = raidStrike(4, 30, 8, 'STRIKE', 10);
    expect(plain).toMatchObject({ damage: 2, shield: 0 });
    const pierced = raidStrike(4, 30, 8, 'PIERCE', 10);
    expect(pierced).toMatchObject({ damage: 6, shield: 4 });
  });
  it('rejects invalid input before touching the boss', () => {
    for (const round of [0, 7]) expect(() => raidStrike(round, 10, 0, 'STRIKE', 5)).toThrow();
    expect(() => raidStrike(1, 0, 0, 'STRIKE', 5)).toThrow();
    expect(() => raidStrike(1, 10, -1, 'STRIKE', 5)).toThrow();
    expect(() => raidStrike(1, 10, 0, 'BLOCK' as never, 5)).toThrow();
    expect(() => raidStrike(1, 10, 0, 'STRIKE', 1.5)).toThrow();
  });
  it('advances the round only on a cleared round and never past six', () => {
    expect(raidRoundAfter(1, false)).toBe(1);
    expect(raidRoundAfter(1, true)).toBe(2);
    expect(raidRoundAfter(6, true)).toBe(6);
    expect(() => raidRoundAfter(7, true)).toThrow();
  });
});

describe('raid reward split', () => {
  it('pays by damage share, gives the remainder to the leader and keeps the pool exact', () => {
    const pool = { gold: 100, dust: 7 };
    const result = raidReward(
      [
        { memberId: 'a', damage: 10 },
        { memberId: 'b', damage: 20 },
        { memberId: 'c', damage: 30 },
      ],
      pool,
    );
    expect(result).toEqual([
      { memberId: 'a', gold: 16, dust: 1 },
      { memberId: 'b', gold: 33, dust: 2 },
      { memberId: 'c', gold: 51, dust: 4 },
    ]);
    expect(result.reduce((sum, entry) => sum + entry.gold, 0)).toBe(pool.gold);
    expect(result.reduce((sum, entry) => sum + entry.dust, 0)).toBe(pool.dust);
  });
  it('ignores members without damage and refuses an empty raid', () => {
    const result = raidReward(
      [
        { memberId: 'a', damage: 0 },
        { memberId: 'b', damage: 5 },
      ],
      { gold: 10, dust: 2 },
    );
    expect(result).toEqual([{ memberId: 'b', gold: 10, dust: 2 }]);
    expect(() => raidReward([], { gold: 10, dust: 2 })).toThrow();
    expect(() => raidReward([{ memberId: 'a', damage: 0 }], { gold: 10, dust: 2 })).toThrow();
  });
  it('grows the pool with the room size', () => {
    expect(raidRewardPool(1)).toEqual({ gold: 65, dust: 7 });
    expect(raidRewardPool(4)).toEqual({ gold: 140, dust: 16 });
  });
});
