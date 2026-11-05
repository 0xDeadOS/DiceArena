import { describe, expect, it } from 'vitest';
import { SPHERE_TYPES } from '@dicebound/shared-types';
import type { CombatDie, DieDTO } from '@dicebound/shared-types';
import {
  AFFIXES,
  craftDie,
  craftRejection,
  dismantleDust,
  dismantlePermission,
  evaluateDiePowerScore,
  facetingRange,
  facePlay,
  isDestructiveCraft,
  parseCombatDie,
  rollAffixes,
  starterFaces,
} from './index.js';
const die: CombatDie = {
  id: '10000000-0000-4000-8000-000000000001',
  baseType: 'BONE',
  ilvl: 1,
  quality: 0,
  rarity: 'NORMAL',
  faces: starterFaces(),
  affixes: [],
  powerScore: 55,
  contentVersion: 0,
};
const noRandom = () => {
  throw new Error('Unexpected randomness');
};
const magic = () => craftDie(die, 'CASTING', () => 0);
const rare = () => craftDie(magic(), 'ASCENDANCE', (max) => max - 1);
const asItem = (data: CombatDie, extra: Partial<DieDTO> = {}): DieDTO => ({
  ...data,
  contentVersion: data.contentVersion ?? 0,
  effectiveFaces: data.faces.map((f) => ({ ...f, value: facePlay(data, f.face).value })),
  isEquipped: false,
  isStarter: false,
  isLocked: false,
  masterCrafted: false,
  ...extra,
});
// Deterministic test-only draw source. Never used by the API/client.
const sequence = (initial: number) => {
  let state = initial;
  return (max: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % max;
  };
};
describe('six-sphere crafting', () => {
  it('tempers by five, caps at twenty and never mutates input or uses RNG', () => {
    let item = die;
    for (let quality = 5; quality <= 20; quality += 5) {
      item = craftDie(item, 'TEMPERING', noRandom);
      expect(item.quality).toBe(quality);
      expect(item.contentVersion).toBe(quality / 5);
    }
    expect(() => craftDie(item, 'TEMPERING', noRandom)).toThrow();
    expect(die.quality).toBe(0);
    expect(craftDie({ ...die, quality: 18 }, 'TEMPERING', noRandom).quality).toBe(20);
  });
  it('facets exactly one server-selected face, with an ilvl-dependent value and stable identity', () => {
    const draws = [3, 0, 3];
    let index = 0;
    const before = structuredClone(rare());
    const result = craftDie(before, 'FACETING', () => draws[index++]!);
    expect(result.faces[3]).toEqual({ face: 4, action: 'STRIKE', value: 7 });
    expect(
      result.faces.filter((f, i) => JSON.stringify(f) !== JSON.stringify(before.faces[i])),
    ).toHaveLength(1);
    expect(result.affixes).toEqual(before.affixes);
    expect(result.quality).toBe(before.quality);
    expect(result.id).toBe(before.id);
    expect(before.faces[3]?.action).toBe('PIERCE');
  });
  it('allows a randomly identical faceting result but still increments the content version', () => {
    const draws = [0, 0, 0];
    let i = 0;
    const result = craftDie(die, 'FACETING', () => draws[i++]!);
    expect(result.faces).toEqual(die.faces);
    expect(result.contentVersion).toBe(1);
  });
  it('casting creates or replaces one/two magic affixes; it is not a new-item operation', () => {
    const first = magic();
    const next = craftDie(first, 'CASTING', (max) => max - 1);
    expect(first).toMatchObject({ id: die.id, rarity: 'MAGIC' });
    expect(first.affixes).toHaveLength(1);
    expect(next.affixes).toHaveLength(2);
    expect(next.faces).toEqual(die.faces);
    expect(next.affixes).not.toEqual(first.affixes);
    expect(() => craftDie(rare(), 'CASTING', noRandom)).toThrow();
  });
  it('ascendance preserves old affixes exactly and fills a three/four-affix rare with max 2+2', () => {
    const first = craftDie(die, 'CASTING', () => 0);
    const result = craftDie(first, 'ASCENDANCE', (max) => max - 1);
    expect(result.rarity).toBe('RARE');
    expect(result.affixes).toHaveLength(4);
    expect(result.affixes[0]).toEqual(first.affixes[0]);
    expect(result.affixes.filter((a) => a.kind === 'PREFIX')).toHaveLength(2);
    expect(result.affixes.filter((a) => a.kind === 'SUFFIX')).toHaveLength(2);
  });
  it('reshaping replaces all affixes; cleansing removes them without resetting quality or faces', () => {
    const first = { ...rare(), quality: 15 };
    const reset = craftDie(first, 'RESHAPING', () => 0);
    expect(reset.affixes).toHaveLength(3);
    expect(reset.affixes).not.toEqual(first.affixes);
    const cleared = craftDie(reset, 'CLEANSING', noRandom);
    expect(cleared).toMatchObject({
      rarity: 'NORMAL',
      affixes: [],
      quality: 15,
      faces: first.faces,
    });
    expect(cleared.powerScore).toBe(evaluateDiePowerScore(cleared));
  });
  it.each(SPHERE_TYPES)('rejects protected/unique loadouts for %s before RNG', (sphere) => {
    expect(() => craftDie({ ...die, isLocked: true }, sphere, noRandom)).toThrow();
    expect(() => craftDie({ ...die, rarity: 'UNIQUE' }, sphere, noRandom)).toThrow();
  });
  it('rejects incompatible rarity and no-op cleansing; destructive recipes are explicit', () => {
    for (const sphere of ['ASCENDANCE', 'RESHAPING', 'CLEANSING'] as const)
      expect(craftRejection(die, sphere)).not.toBeNull();
    expect(isDestructiveCraft(die, 'CASTING')).toBe(false);
    expect(isDestructiveCraft(magic(), 'CASTING')).toBe(true);
    expect(isDestructiveCraft(die, 'FACETING')).toBe(true);
    expect(isDestructiveCraft(magic(), 'ASCENDANCE')).toBe(false);
  });
  it('uses only eligible tiers and bounded distinct 2+2 pools across many deterministic draws', () => {
    for (const ilvl of [1, 9, 10, 19, 20, 50])
      for (let seed = 0; seed < 60; seed++) {
        const affixes = rollAffixes(ilvl, 4, [], sequence(seed));
        const item = { ...die, ilvl, rarity: 'RARE' as const, affixes };
        expect(parseCombatDie(item)).toMatchObject({ affixes });
        expect(new Set(affixes.map((a) => a.id)).size).toBe(4);
        expect(affixes.every((a) => a.tier <= (ilvl >= 20 ? 3 : ilvl >= 10 ? 2 : 1))).toBe(true);
      }
  });
  it('selects low/high allowed values and rejects invalid RNG and ilvl', () => {
    expect(rollAffixes(1, 1, [], () => 0)[0]).toEqual({
      id: 'P1',
      kind: 'PREFIX',
      tier: 1,
      value: 1,
    });
    expect(rollAffixes(20, 1, [], (max) => max - 1)[0]).toEqual({
      id: 'S7',
      kind: 'SUFFIX',
      tier: 3,
      value: 30,
    });
    expect(() => craftDie(die, 'CASTING', () => -1)).toThrow();
    expect(() => craftDie(die, 'FACETING', (max) => max)).toThrow();
    expect(() => facetingRange(0, 'STRIKE')).toThrow();
    expect(facetingRange(1, 'HEAL')).toEqual([2, 4]);
    expect(facetingRange(50, 'STRIKE')).toEqual([13, 16]);
  });
});
describe('power score model v1', () => {
  it('keeps starter 55, includes base/quality and never adds a rarity multiplier', () => {
    expect(evaluateDiePowerScore(die)).toBe(55);
    expect(evaluateDiePowerScore({ ...die, rarity: 'RARE' })).toBe(55);
    expect(evaluateDiePowerScore({ ...die, baseType: 'IRON' })).toBe(59);
    expect(evaluateDiePowerScore({ ...die, quality: 20 })).toBeGreaterThan(55);
  });
  it.each(Object.keys(AFFIXES))('accounts for active/passive utility of %s', (id) => {
    const def = AFFIXES[id]!;
    const item = {
      ...die,
      ilvl: 20,
      rarity: 'MAGIC' as const,
      affixes: [{ id, kind: def.kind, tier: 3 as const, value: def.ranges[2][0] }],
    };
    expect(evaluateDiePowerScore(item)).toBeGreaterThan(55);
  });
  it('quality is monotonic for valid random loadouts, and evaluation has no RNG', () => {
    for (let i = 0; i < 80; i++) {
      const random = sequence(i);
      const item = {
        ...die,
        ilvl: 20,
        rarity: 'RARE' as const,
        affixes: rollAffixes(20, 4, [], random),
      };
      let last = 0;
      for (let quality = 0; quality <= 20; quality++) {
        const score = evaluateDiePowerScore({ ...item, quality });
        expect(score).toBeGreaterThanOrEqual(last);
        last = score;
      }
    }
  });
});
describe('dismantling rules', () => {
  it('protects starter, locked, equipped, active-run and unsupported unique gear', () => {
    for (const extra of [
      { isStarter: true },
      { isLocked: true },
      { isEquipped: true },
      { rarity: 'UNIQUE' as const },
    ])
      expect(dismantlePermission(asItem(die, extra), null).allowed).toBe(false);
    expect(dismantlePermission(asItem(die), die.id).allowed).toBe(false);
    expect(dismantlePermission(asItem(die), null).allowed).toBe(true);
  });
  it('gives only the documented dust amount by supported rarity', () => {
    expect(['NORMAL', 'MAGIC', 'RARE'].map((r) => dismantleDust(r as CombatDie['rarity']))).toEqual(
      [1, 3, 6],
    );
    expect(dismantleDust('UNIQUE')).toBe(0);
  });
});
