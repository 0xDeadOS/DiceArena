import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  addExpeditionLoot,
  emptyExpeditionLoot,
  expeditionLootSchema,
  expeditionMap,
  expeditionReward,
  expeditionScale,
  generateDrop,
  settleExpeditionLoot,
  tutorialProgress,
} from './expeditions.js';
import { evaluateDiePowerScore } from './workshop.js';
import { parseCombatDie, combatStats } from './catalog.js';
import { newCombat, decideCombat, rollCombat } from './combat.js';
import { enemyIntent } from './enemies.js';
import { SPHERE_TYPES } from '@dicebound/shared-types';
function rng(seed: number) {
  let state = seed;
  return (max: number) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state % max;
  };
}
const id = '00000000-0000-4000-8000-000000000001';
describe('provisional expedition economy', () => {
  it('keeps bounded DAGs at seven depths', () => {
    for (let i = 0; i < 50; i++) {
      const map = expeditionMap(rng(i));
      expect(map).toHaveLength(13);
      expect(map.at(-1)!.type).toBe('BOSS');
      for (const node of map)
        for (const next of node.next)
          expect(map.find((n) => n.id === next)!.depth).toBe(node.depth + 1);
    }
  });
  it('generates valid level-bounded dice, PS, bases and affixes without mutating inputs', () => {
    const bases = new Set(),
      rarities = new Set();
    for (let level = 1; level <= 50; level++)
      for (let i = 0; i < 15; i++) {
        const die = generateDrop(id, level, rng(level * 100 + i));
        expect(parseCombatDie(die)).toEqual(die);
        expect(die.ilvl).toBeGreaterThanOrEqual(Math.max(1, level - 2));
        expect(die.ilvl).toBeLessThanOrEqual(Math.min(50, level + 1));
        expect(die.powerScore).toBe(evaluateDiePowerScore(die));
        expect(die.contentVersion).toBe(0);
        expect(die.faces.some((f) => f.action === 'STRIKE')).toBe(true);
        expect(die.faces.some((f) => f.action === 'GUARD')).toBe(true);
        bases.add(die.baseType);
        rarities.add(die.rarity);
      }
    expect([...bases].sort()).toEqual(['BONE', 'IRON', 'OBSIDIAN']);
    expect([...rarities].sort()).toEqual(['MAGIC', 'NORMAL', 'RARE']);
  });
  it.each([0, -1, 1.5, 51, NaN])('rejects bad level %s', (level) =>
    expect(() => generateDrop(id, level, rng(1))).toThrow(),
  );
  it.each([() => -1, () => 0.5, (max: number) => max])('rejects invalid random sources', (random) =>
    expect(() => generateDrop(id, 1, random)).toThrow(),
  );
  it('is deterministic with the supplied entropy, including an invariant boss reward', () => {
    expect(generateDrop(id, 20, rng(42))).toEqual(generateDrop(id, 20, rng(42)));
    for (let seed = 0; seed < 100; seed++) {
      const reward = expeditionReward('BOSS', 1, rng(seed), () => id);
      expect(reward.dice).toHaveLength(1);
      expect(reward.spheres).toHaveLength(1);
      expect(reward.gold).toBe(30);
    }
  });
  it('can produce all six sphere types and no loot from non-loot nodes', () => {
    const found = new Set();
    for (let i = 0; i < 1000; i++)
      found.add(expeditionReward('BOSS', 1, rng(i), () => id).spheres[0]!.type);
    expect([...found].sort()).toEqual([...SPHERE_TYPES].sort());
    const fail = () => {
      throw new Error('Unexpected RNG');
    };
    expect(expeditionReward('START', 1, fail, fail)).toEqual(emptyExpeditionLoot());
    expect(expeditionReward('CAMP', 1, fail, fail)).toEqual(emptyExpeditionLoot());
  });
  it('merges stacks and settles exactly 40 percent of whole units on defeat', () => {
    let loot = emptyExpeditionLoot();
    for (let i = 0; i < 5; i++)
      loot = addExpeditionLoot(
        loot,
        expeditionReward(
          'BOSS',
          1,
          () => 0,
          () => randomUUID(),
        ),
      );
    const copy = structuredClone(loot);
    const result = settleExpeditionLoot(loot, false, rng(7));
    expect(result).toMatchObject({
      gold: 60,
      dust: 8,
      spheres: [{ type: 'TEMPERING', amount: 2 }],
    });
    expect(result.dice).toHaveLength(2);
    expect(new Set(result.dice.map((d) => d.id)).size).toBe(2);
    expect(loot).toEqual(copy);
    expect(settleExpeditionLoot(loot, false, rng(7))).toEqual(result);
    const victory = settleExpeditionLoot(loot, true, () => {
      throw new Error('No extra rolls on victory');
    });
    expect(victory).toEqual(loot);
    expect(victory).not.toBe(loot);
  });
  it('does not round a single lost sphere or die up into a reward', () => {
    const reward = settleExpeditionLoot(
      expeditionReward(
        'BOSS',
        1,
        () => 0,
        () => id,
      ),
      false,
      rng(0),
    );
    expect(reward.dice).toEqual([]);
    expect(reward.spheres).toEqual([]);
  });
  it('rejects duplicate item IDs, sphere stacks and unbounded loot', () => {
    const one = expeditionReward(
      'BOSS',
      1,
      () => 0,
      () => id,
    );
    expect(() => addExpeditionLoot(one, one)).toThrow();
    expect(() =>
      expeditionLootSchema.parse({ ...one, spheres: [...one.spheres, ...one.spheres] }),
    ).toThrow();
    expect(() =>
      expeditionLootSchema.parse({ ...one, spheres: [{ type: 'CASTING', amount: 8 }] }),
    ).toThrow();
  });
});
describe('frozen normal difficulty and guided progress', () => {
  it('scales subsequent intents with the same saved scale, not back to training', () => {
    const die = generateDrop(id, 1, () => 0);
    const hp = combatStats(die).maxHp;
    const initial = newCombat('SLIME', die, hp, hp, expeditionScale(1));
    expect(initial.enemyHp).toBe(20);
    expect(initial.currentIntent.value).toBe(5);
    const next = decideCombat(rollCombat(initial, 1), die, 'DIRECT');
    expect(next.currentIntent.value).toBe(4);
    expect(next.currentIntent.heal).toBe(3);
    expect(next.enemyScale).toBe(1000);
    expect(newCombat('SLIME', die, hp, hp).enemyHp).toBe(12);
    expect(expeditionScale(50)).toBe(2960);
  });
  it('scales damage/healing but not percentage effects or already accumulated shield', () => {
    expect(enemyIntent('STONE_GUARD', 2, 90, 90, 11, 2000)).toMatchObject({
      value: 27,
      baseValue: 16,
    });
    expect(enemyIntent('BLOOD_PRIEST', 1, 80, 80, 0, 2000)).toMatchObject({
      value: 14,
      lifestealPercent: 50,
    });
    expect(enemyIntent('BLOOD_PRIEST', 2, 80, 80, 0, 2000).value).toBe(30);
  });
  it('requires verified training, claim, craft and explicit completion, crediting out-of-order crafting', () => {
    expect(tutorialProgress(false, false, false, false).step).toBe('TRAINING');
    expect(tutorialProgress(true, false, false, false).step).toBe('REWARD');
    expect(tutorialProgress(true, false, true, false).step).toBe('CRAFT');
    expect(tutorialProgress(true, true, true, false).step).toBe('COMPLETE');
    expect(tutorialProgress(true, true, true, true).step).toBe('DONE');
    expect(tutorialProgress(true, true, false, false).step).toBe('REWARD');
  });
});
