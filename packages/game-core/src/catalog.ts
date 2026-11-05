import { z } from 'zod';
import { DIE_BASES, FACE_ACTIONS, RARITIES } from '@dicebound/shared-types';
import type { CombatDie, DieBase, FacePlay } from '@dicebound/shared-types';
import { effectiveFaceValue } from './foundation.js';

export const BASES: Record<DieBase, { guardFlat: number; guardPercent: number }> = {
  BONE: { guardFlat: 0, guardPercent: 0 },
  IRON: { guardFlat: 1, guardPercent: 0 },
  OBSIDIAN: { guardFlat: 0, guardPercent: 5 },
};
type TierRanges = readonly [
  readonly [number, number],
  readonly [number, number],
  readonly [number, number],
];
interface AffixDefinition {
  kind: 'PREFIX' | 'SUFFIX';
  ranges: TierRanges;
  weight: number;
}
const fixed = (a: number, b: number, c: number): TierRanges => [
  [a, a],
  [b, b],
  [c, c],
];
export const AFFIXES: Record<string, AffixDefinition> = {
  P1: { kind: 'PREFIX', ranges: fixed(1, 2, 4), weight: 100 },
  P2: { kind: 'PREFIX', ranges: fixed(1, 2, 4), weight: 100 },
  P3: {
    kind: 'PREFIX',
    ranges: [
      [10, 15],
      [16, 25],
      [26, 40],
    ],
    weight: 80,
  },
  P4: {
    kind: 'PREFIX',
    ranges: [
      [10, 15],
      [16, 25],
      [26, 40],
    ],
    weight: 80,
  },
  P5: { kind: 'PREFIX', ranges: fixed(3, 6, 10), weight: 60 },
  P6: { kind: 'PREFIX', ranges: fixed(2, 5, 9), weight: 70 },
  P7: { kind: 'PREFIX', ranges: fixed(1, 2, 3), weight: 60 },
  P8: { kind: 'PREFIX', ranges: fixed(2, 4, 8), weight: 70 },
  S1: { kind: 'SUFFIX', ranges: fixed(8, 14, 20), weight: 60 },
  S2: { kind: 'SUFFIX', ranges: fixed(1, 2, 3), weight: 50 },
  S3: { kind: 'SUFFIX', ranges: fixed(1, 2, 3), weight: 70 },
  S4: { kind: 'SUFFIX', ranges: fixed(2, 4, 7), weight: 80 },
  S5: { kind: 'SUFFIX', ranges: fixed(20, 35, 50), weight: 50 },
  S6: { kind: 'SUFFIX', ranges: fixed(65, 75, 90), weight: 60 },
  S7: { kind: 'SUFFIX', ranges: fixed(8, 16, 30), weight: 100 },
};
export const combatDieSchema = z
  .object({
    id: z.uuid(),
    contentVersion: z.number().int().nonnegative().default(0),
    baseType: z.enum(DIE_BASES),
    ilvl: z.number().int().min(1).max(50),
    quality: z.number().int().min(0).max(20),
    rarity: z.enum(RARITIES),
    faces: z
      .array(
        z.object({
          face: z.number().int().min(1).max(6),
          action: z.enum(FACE_ACTIONS),
          value: z.number().int().min(1).max(1000),
        }),
      )
      .length(6),
    affixes: z
      .array(
        z.object({
          id: z.string(),
          kind: z.enum(['PREFIX', 'SUFFIX']),
          tier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
          value: z.number().int().nonnegative(),
        }),
      )
      .max(4),
    powerScore: z.number().int().nonnegative(),
  })
  .superRefine((die, ctx) => {
    const invalid = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (new Set(die.faces.map((f) => f.face)).size !== 6) invalid('Six distinct faces required');
    if (new Set(die.affixes.map((a) => a.id)).size !== die.affixes.length)
      invalid('Duplicate affix');
    for (const kind of ['PREFIX', 'SUFFIX'])
      if (die.affixes.filter((a) => a.kind === kind).length > 2) invalid('Affix kind limit');
    if (die.rarity === 'NORMAL' && die.affixes.length !== 0) invalid('Normal die has affixes');
    if (die.rarity === 'MAGIC' && (die.affixes.length < 1 || die.affixes.length > 2))
      invalid('Magic affix count');
    if (die.rarity === 'RARE' && die.affixes.length < 3) invalid('Rare affix count');
    // Уникальный кубик — вершина редкости: всегда ровно 2+2 свойства, поэтому предел
    // набора (4) достигается только им. Проверка избыточна с общей, но фиксирует намерение.
    if (die.rarity === 'UNIQUE' && die.affixes.length !== 4) invalid('Unique affix count');
    for (const affix of die.affixes) {
      const definition = Object.hasOwn(AFFIXES, affix.id) ? AFFIXES[affix.id] : undefined;
      const range = definition?.ranges[affix.tier - 1];
      if (
        !definition ||
        definition.kind !== affix.kind ||
        !range ||
        affix.value < range[0] ||
        affix.value > range[1] ||
        die.ilvl < [1, 10, 20][affix.tier - 1]!
      )
        invalid('Invalid affix tier/value');
    }
  });
export const parseCombatDie = (value: unknown): CombatDie => combatDieSchema.parse(value);
export function affixValue(die: CombatDie, id: string) {
  return die.affixes.find((a) => a.id === id)?.value ?? 0;
}
export function combatStats(die: CombatDie) {
  return {
    maxHp: 50 + affixValue(die, 'S7'),
    rerolls: 1 + affixValue(die, 'S2'),
    focus: Math.min(3, affixValue(die, 'S3')),
    thorns: affixValue(die, 'P6'),
    strikeIgnore: affixValue(die, 'P8'),
    lifesteal: affixValue(die, 'S1'),
    poison: affixValue(die, 'S4'),
    retention: affixValue(die, 'S5'),
    stance: affixValue(die, 'S6') || 50,
  };
}
export function facePlay(die: CombatDie, faceNumber: number): FacePlay {
  const face = die.faces.find((f) => f.face === faceNumber);
  if (!face) throw new Error('Invalid die face');
  let flat =
    (face.face === 6 ? affixValue(die, 'P5') : 0) +
    (face.face % 2 === 0 ? affixValue(die, 'P7') : 0);
  let percent = 0;
  if (face.action === 'STRIKE') flat += affixValue(die, 'P1');
  if (face.action === 'STRIKE' || face.action === 'PIERCE') percent += affixValue(die, 'P3');
  if (face.action === 'GUARD') {
    flat += affixValue(die, 'P2') + BASES[die.baseType].guardFlat;
    percent += affixValue(die, 'P4') + BASES[die.baseType].guardPercent;
  }
  const value = effectiveFaceValue(face.value, die.quality, { flat, percent });
  return { face: face.face, action: face.action, value };
}
