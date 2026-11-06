import { z } from 'zod';
import { DIE_BASES, FACE_ACTIONS, SPHERE_TYPES } from '@dicebound/shared-types';
import type {
  CombatDie,
  DieFace,
  MapNodeType,
  SphereStack,
  TutorialProgress,
} from '@dicebound/shared-types';
import { combatDieSchema, parseCombatDie } from './catalog.js';
import { evaluateDiePowerScore, facetingRange, rollAffixes } from './workshop.js';
import type { RandomInt } from './workshop.js';
import { lootSchema, trainingMap } from './maps.js';
export const EXPEDITION_RULES = 'EXPEDITION_V1' as const;
export const EXPEDITION_COST = 1;
export function expeditionScale(level: number) {
  if (!Number.isInteger(level) || level < 1 || level > 50)
    throw new RangeError('Invalid expedition level');
  return 1000 + (level - 1) * 40;
}
export function tutorialProgress(
  trainingWon: boolean,
  crafted: boolean,
  rewardClaimed: boolean,
  done: boolean,
): TutorialProgress {
  return {
    trainingWon,
    crafted,
    rewardClaimed,
    step: done
      ? 'DONE'
      : !trainingWon
        ? 'TRAINING'
        : !rewardClaimed
          ? 'REWARD'
          : !crafted
            ? 'CRAFT'
            : 'COMPLETE',
  };
}
function draw(random: RandomInt, max: number) {
  const value = random(max);
  if (!Number.isInteger(value) || value < 0 || value >= max)
    throw new RangeError('Invalid random draw');
  return value;
}
function weighted<T>(values: readonly T[], weights: readonly number[], random: RandomInt): T {
  let n = draw(
    random,
    weights.reduce((sum, v) => sum + v, 0),
  );
  for (let i = 0; i < values.length; i++) {
    if (n < weights[i]!) return values[i]!;
    n -= weights[i]!;
  }
  throw new Error('Invalid weighted pool');
}
export const expeditionMap = trainingMap;
export const expeditionLootSchema = lootSchema.extend({
  spheres: z
    .array(z.object({ type: z.enum(SPHERE_TYPES), amount: z.number().int().positive().max(7) }))
    .max(6)
    .refine((v) => new Set(v.map((s) => s.type)).size === v.length),
  dice: z
    .array(combatDieSchema)
    .max(7)
    .refine((v) => new Set(v.map((d) => d.id)).size === v.length),
});
export type ExpeditionLoot = z.infer<typeof expeditionLootSchema>;
export const emptyExpeditionLoot = (): ExpeditionLoot => ({
  gold: 0,
  dust: 0,
  spheres: [],
  dice: [],
});
/** Bounded generator: at least one attack and guard, four other actions, then a shuffle. */
export function generateDrop(id: string, level: number, random: RandomInt): CombatDie {
  expeditionScale(level);
  const low = Math.max(1, level - 2),
    high = Math.min(50, level + 1);
  const ilvl = low + draw(random, high - low + 1);
  const actions = [
    FACE_ACTIONS[0],
    FACE_ACTIONS[1],
    ...Array.from({ length: 4 }, () => FACE_ACTIONS[draw(random, 4)]!),
  ];
  for (let i = actions.length - 1; i > 0; i--) {
    const j = draw(random, i + 1);
    [actions[i], actions[j]] = [actions[j]!, actions[i]!];
  }
  const faces: DieFace[] = actions.map((action, index) => {
    const [min, max] = facetingRange(ilvl, action);
    return { face: index + 1, action, value: min + draw(random, max - min + 1) };
  });
  const rarity = weighted(['NORMAL', 'MAGIC', 'RARE'] as const, [70, 25, 5], random);
  const die: CombatDie = {
    id,
    contentVersion: 0,
    baseType: weighted(DIE_BASES, [40, 35, 25], random),
    ilvl,
    quality: 0,
    rarity,
    faces,
    affixes:
      rarity === 'NORMAL'
        ? []
        : rollAffixes(ilvl, (rarity === 'MAGIC' ? 1 : 3) + draw(random, 2), [], random),
    powerScore: 0,
  };
  die.powerScore = evaluateDiePowerScore(die);
  return parseCombatDie(die);
}
export function expeditionReward(
  type: MapNodeType,
  level: number,
  random: RandomInt,
  newId: () => string,
): ExpeditionLoot {
  expeditionScale(level);
  const rates = {
    BATTLE: [8 + 2 * level, 1, 25, 10],
    ELITE: [14 + 3 * level, 2, 70, 35],
    CHEST: [6 + level, 1, 80, 40],
    BOSS: [25 + 5 * level, 4, 100, 100],
  } as const;
  if (type === 'START' || type === 'CAMP') return emptyExpeditionLoot();
  const [gold, dust, sphereChance, dieChance] = rates[type];
  const spheres: SphereStack[] = [];
  if (draw(random, 100) < sphereChance)
    spheres.push({ type: weighted(SPHERE_TYPES, [25, 25, 25, 12, 8, 5], random), amount: 1 });
  const dice = draw(random, 100) < dieChance ? [generateDrop(newId(), level, random)] : [];
  return expeditionLootSchema.parse({ gold, dust, spheres, dice });
}
export function addExpeditionLoot(a: ExpeditionLoot, b: ExpeditionLoot): ExpeditionLoot {
  return expeditionLootSchema.parse({
    gold: a.gold + b.gold,
    dust: a.dust + b.dust,
    dice: [...a.dice, ...b.dice],
    spheres: SPHERE_TYPES.map((type) => ({
      type,
      amount:
        (a.spheres.find((s) => s.type === type)?.amount ?? 0) +
        (b.spheres.find((s) => s.type === type)?.amount ?? 0),
    })).filter((s) => s.amount > 0),
  });
}
export function settleExpeditionLoot(
  loot: ExpeditionLoot,
  victory: boolean,
  random: RandomInt,
): ExpeditionLoot {
  if (victory) return structuredClone(loot);
  const count = Math.floor(loot.dice.length * 0.4);
  const indices = loot.dice.map((_, i) => i);
  // Sample a subset without replacement; only the server knows it before settlement.
  for (let i = 0; i < count; i++) {
    const j = i + draw(random, indices.length - i);
    [indices[i], indices[j]] = [indices[j]!, indices[i]!];
  }
  const kept = new Set(indices.slice(0, count));
  return {
    gold: Math.floor(loot.gold * 0.4),
    dust: Math.floor(loot.dust * 0.4),
    spheres: loot.spheres
      .map((s) => ({ ...s, amount: Math.floor(s.amount * 0.4) }))
      .filter((s) => s.amount > 0),
    dice: structuredClone(loot.dice.filter((_, i) => kept.has(i))),
  };
}
