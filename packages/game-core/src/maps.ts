import { z } from 'zod';
import type { MapNodeDTO, MapNodeType, TrainingLoot } from '@dicebound/shared-types';
export const mapSchema = z
  .array(
    z.object({
      id: z.string(),
      depth: z.number().int().min(0).max(7),
      lane: z.number().int().min(0).max(1),
      type: z.enum(['START', 'BATTLE', 'ELITE', 'CHEST', 'CAMP', 'BOSS']),
      next: z.array(z.string()).max(2),
    }),
  )
  .max(14);
export const lootSchema = z.object({
  gold: z.number().int().nonnegative(),
  dust: z.number().int().nonnegative(),
});
export function trainingMap(random: (max: number) => number): MapNodeDTO[] {
  const rows: MapNodeType[][] = [
    ['START'],
    ['BATTLE'],
    ['CHEST', 'BATTLE'],
    ['CAMP', 'ELITE'],
    ['BATTLE', 'CHEST'],
    ['CAMP', 'ELITE'],
    ['CHEST', 'CAMP'],
    ['BOSS'],
  ];
  const nodes = rows.flatMap((kinds, depth) => {
    const types = [...kinds];
    if (types.length === 2 && random(2) === 1) types.reverse();
    return types.map((type, lane) => ({
      id: depth === 0 ? 'start' : `f${depth}-${lane}`,
      depth,
      lane,
      type,
      next: depth === 7 ? [] : rows[depth + 1]!.map((_, nextLane) => `f${depth + 1}-${nextLane}`),
    }));
  });
  return nodes;
}
export function trainingReward(type: MapNodeType): TrainingLoot {
  switch (type) {
    case 'BATTLE':
      return { gold: 4, dust: 1 };
    case 'ELITE':
      return { gold: 7, dust: 2 };
    case 'BOSS':
      return { gold: 12, dust: 3 };
    case 'CHEST':
      return { gold: 3, dust: 1 };
    default:
      return { gold: 0, dust: 0 };
  }
}
export function addLoot(a: TrainingLoot, b: TrainingLoot): TrainingLoot {
  return { gold: a.gold + b.gold, dust: a.dust + b.dust };
}
export function settleLoot(loot: TrainingLoot, victory: boolean): TrainingLoot {
  return victory
    ? { ...loot }
    : { gold: Math.floor(loot.gold * 0.4), dust: Math.floor(loot.dust * 0.4) };
}
