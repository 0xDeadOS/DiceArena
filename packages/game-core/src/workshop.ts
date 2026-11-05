import { FACE_ACTIONS, SPHERE_TYPES } from '@dicebound/shared-types';
import type {
  CombatDie,
  DieAffix,
  DieDTO,
  FaceAction,
  SphereType,
  ItemPermission,
} from '@dicebound/shared-types';
import { AFFIXES, affixValue, facePlay, parseCombatDie } from './catalog.js';
import { calculatePowerScore, oppositeFace } from './foundation.js';
import { requireRule } from './rules.js';

export const POWER_SCORE_MODEL = 'ETV_PASSIVE_V1' as const;
export const WORKSHOP_HORIZON = 6;
export type RandomInt = (exclusiveMax: number) => number;
function draw(random: RandomInt, max: number) {
  const value = random(max);
  if (!Number.isInteger(value) || value < 0 || value >= max)
    throw new RangeError('Invalid random draw');
  return value;
}
function weighted<T>(options: readonly { value: T; weight: number }[], random: RandomInt): T {
  let roll = draw(
    random,
    options.reduce((sum, item) => sum + item.weight, 0),
  );
  for (const item of options) {
    if (roll < item.weight) return item.value;
    roll -= item.weight;
  }
  throw new Error('Invalid weighted pool');
}
/** Explicit provisional six-turn utility model, not DPS or a rarity multiplier. */
export function evaluateDiePowerScore(die: CombatDie): number {
  const faces = die.faces.map((f) => ({ ...f, value: facePlay(die, f.face).value }));
  const average = faces.reduce((sum, f) => sum + f.value, 0) / 6;
  const guard = faces.filter((f) => f.action === 'GUARD');
  const attacks = faces.filter((f) => f.action === 'STRIKE' || f.action === 'PIERCE');
  const oppositeGain =
    faces.reduce(
      (sum, f) =>
        sum + Math.max(0, faces.find((o) => o.face === oppositeFace(f.face))!.value - f.value),
      0,
    ) / 6;
  let ev = affixValue(die, 'P6') * (guard.length / 6) * (2 / 3);
  ev +=
    (faces
      .filter((f) => f.action === 'STRIKE')
      .reduce((sum, f) => sum + Math.min(affixValue(die, 'P8'), 4, f.value), 0) /
      6) *
    0.5;
  ev += ((attacks.reduce((sum, f) => sum + f.value, 0) / 6) * affixValue(die, 'S1')) / 100;
  ev +=
    (affixValue(die, 'S2') *
      (faces.reduce((sum, f) => sum + Math.max(0, average - f.value), 0) / 6)) /
    WORKSHOP_HORIZON;
  ev += (Math.min(3, affixValue(die, 'S3')) * oppositeGain) / WORKSHOP_HORIZON;
  ev += (affixValue(die, 'S4') * 3 * faces.filter((f) => f.action === 'PIERCE').length) / 6;
  ev += (((guard.reduce((sum, f) => sum + f.value, 0) / 6) * affixValue(die, 'S5')) / 100) * 0.5;
  const stance = affixValue(die, 'S6') || 50;
  ev +=
    (faces
      .filter((f) => f.action !== 'HEAL')
      .reduce((sum, f) => sum + Math.ceil((f.value * stance) / 100) - Math.ceil(f.value * 0.5), 0) /
      6) *
    0.5;
  ev += affixValue(die, 'S7') / WORKSHOP_HORIZON;
  return calculatePowerScore(faces, 0, {}, ev);
}
export function facetingRange(ilvl: number, action: FaceAction): readonly [number, number] {
  if (!Number.isInteger(ilvl) || ilvl < 1 || ilvl > 50 || !FACE_ACTIONS.includes(action))
    throw new RangeError('Invalid face range');
  const step = Math.floor((ilvl - 1) / 5);
  const ranges: Record<FaceAction, readonly [number, number]> = {
    STRIKE: [4 + step, 7 + step],
    GUARD: [5 + step, 8 + step],
    PIERCE: [3 + step, 6 + step],
    HEAL: [2 + Math.floor(step / 2), 4 + Math.floor(step / 2)],
  };
  return ranges[action];
}
export function rollAffixes(
  ilvl: number,
  count: number,
  kept: readonly DieAffix[],
  random: RandomInt,
): DieAffix[] {
  requireRule(
    Number.isInteger(ilvl) &&
      ilvl >= 1 &&
      ilvl <= 50 &&
      Number.isInteger(count) &&
      count >= kept.length &&
      count <= 4,
    'INVALID_AFFIX_ROLL',
    'Недопустимый набор свойств.',
  );
  const result = structuredClone([...kept]);
  while (result.length < count) {
    const pool = Object.entries(AFFIXES).filter(
      ([id, def]) =>
        !result.some((a) => a.id === id) && result.filter((a) => a.kind === def.kind).length < 2,
    );
    const id = weighted(
      pool.map(([value, def]) => ({ value, weight: def.weight })),
      random,
    );
    const def = AFFIXES[id]!;
    const tiers: { value: 1 | 2 | 3; weight: number }[] = [{ value: 1, weight: 70 }];
    if (ilvl >= 10) tiers.push({ value: 2, weight: 25 });
    if (ilvl >= 20) tiers.push({ value: 3, weight: 5 });
    const tier = tiers.length === 1 ? 1 : weighted(tiers, random);
    const [low, high] = def.ranges[tier - 1]!;
    const value = low === high ? low : low + draw(random, high - low + 1);
    result.push({ id, kind: def.kind, tier, value });
  }
  return result;
}
interface Rejection {
  code: string;
  message: string;
}
export function craftRejection(
  die: Pick<CombatDie, 'rarity' | 'quality'> & { isLocked?: boolean },
  sphere: SphereType,
): Rejection | null {
  if (!SPHERE_TYPES.includes(sphere))
    return { code: 'INVALID_SPHERE', message: 'Неизвестная сфера.' };
  if (die.isLocked) return { code: 'DIE_LOCKED', message: 'Сначала снимите защиту кубика.' };
  if (die.rarity === 'UNIQUE')
    return { code: 'UNSUPPORTED_DIE', message: 'Уникальные кубики пока нельзя изменять.' };
  if (sphere === 'TEMPERING' && die.quality >= 20)
    return { code: 'QUALITY_MAXIMUM', message: 'Качество уже достигло 20%.' };
  if (sphere === 'CASTING' && !['NORMAL', 'MAGIC'].includes(die.rarity))
    return {
      code: 'RARITY_MISMATCH',
      message: 'Отливка работает с обычными и магическими кубиками.',
    };
  if (sphere === 'ASCENDANCE' && die.rarity !== 'MAGIC')
    return { code: 'RARITY_MISMATCH', message: 'Возвышение требует магический кубик.' };
  if (sphere === 'RESHAPING' && die.rarity !== 'RARE')
    return { code: 'RARITY_MISMATCH', message: 'Перерождение требует редкий кубик.' };
  if (sphere === 'CLEANSING' && die.rarity === 'NORMAL')
    return { code: 'NOTHING_TO_CLEANSE', message: 'У обычного кубика нет свойств для очищения.' };
  return null;
}
export function isDestructiveCraft(die: Pick<CombatDie, 'rarity'>, sphere: SphereType): boolean {
  return (
    ['FACETING', 'RESHAPING', 'CLEANSING'].includes(sphere) ||
    (sphere === 'CASTING' && die.rarity === 'MAGIC')
  );
}
export function craftDie(
  previous: CombatDie & { isLocked?: boolean },
  sphere: SphereType,
  random: RandomInt,
): CombatDie {
  const rejection = craftRejection(previous, sphere);
  requireRule(
    !rejection,
    rejection?.code ?? 'CRAFT_UNAVAILABLE',
    rejection?.message ?? 'Крафт недоступен.',
  );
  const die = parseCombatDie(previous);
  switch (sphere) {
    case 'TEMPERING':
      die.quality = Math.min(20, die.quality + 5);
      break;
    case 'FACETING': {
      const index = draw(random, 6);
      const action = FACE_ACTIONS[draw(random, FACE_ACTIONS.length)]!;
      const [low, high] = facetingRange(die.ilvl, action);
      die.faces[index] = {
        face: die.faces[index]!.face,
        action,
        value: low + draw(random, high - low + 1),
      };
      break;
    }
    case 'CASTING':
      die.rarity = 'MAGIC';
      die.affixes = rollAffixes(die.ilvl, 1 + draw(random, 2), [], random);
      break;
    case 'ASCENDANCE':
      die.rarity = 'RARE';
      die.affixes = rollAffixes(die.ilvl, 3 + draw(random, 2), die.affixes, random);
      break;
    case 'RESHAPING':
      die.affixes = rollAffixes(die.ilvl, 3 + draw(random, 2), [], random);
      break;
    case 'CLEANSING':
      die.rarity = 'NORMAL';
      die.affixes = [];
      break;
  }
  die.contentVersion = (die.contentVersion ?? 0) + 1;
  die.powerScore = evaluateDiePowerScore(die);
  return parseCombatDie(die);
}
/**
 * Мастерская огранка: игрок выбирает грань и действие, базовое значение остаётся серверным
 * броском в том же диапазоне, что и у сферы Гранения. Цена — пыль, растёт вместе с ilvl.
 * Временные параметры этого инкремента, не финальный баланс.
 */
export const MASTER_FACET_BASE_COST = 5;
export const MASTER_FACET_STEP_COST = 3;
export function masterFacetCost(ilvl: number): number {
  if (!Number.isInteger(ilvl) || ilvl < 1 || ilvl > 50) throw new RangeError('Invalid ilvl');
  return MASTER_FACET_BASE_COST + MASTER_FACET_STEP_COST * Math.floor((ilvl - 1) / 5);
}
export function masterFacetRejection(
  die: Pick<CombatDie, 'rarity'> & { isLocked?: boolean },
  face: number,
  action: FaceAction,
): Rejection | null {
  if (!Number.isInteger(face) || face < 1 || face > 6)
    return { code: 'INVALID_FACE', message: 'Грань должна быть от 1 до 6.' };
  if (!FACE_ACTIONS.includes(action))
    return { code: 'INVALID_ACTION', message: 'Неизвестное действие грани.' };
  if (die.isLocked) return { code: 'DIE_LOCKED', message: 'Сначала снимите защиту кубика.' };
  if (die.rarity === 'UNIQUE')
    return { code: 'UNSUPPORTED_DIE', message: 'Уникальные кубики пока нельзя изменять.' };
  return null;
}
/** Never awards a free preview: the value is drawn inside the published faceting range. */
export function masterFacetDie(
  previous: CombatDie & { isLocked?: boolean },
  face: number,
  action: FaceAction,
  random: RandomInt,
): CombatDie {
  const rejection = masterFacetRejection(previous, face, action);
  requireRule(
    !rejection,
    rejection?.code ?? 'MASTER_FACET_UNAVAILABLE',
    rejection?.message ?? 'Огранка недоступна.',
  );
  const die = parseCombatDie(previous);
  const [low, high] = facetingRange(die.ilvl, action);
  const index = die.faces.findIndex((f) => f.face === face);
  requireRule(index >= 0, 'INVALID_FACE', 'У кубика нет такой грани.');
  die.faces[index] = { face, action, value: low + draw(random, high - low + 1) };
  die.contentVersion = (die.contentVersion ?? 0) + 1;
  die.powerScore = evaluateDiePowerScore(die);
  return parseCombatDie(die);
}
export const dismantleDust = (rarity: CombatDie['rarity']) =>
  ({ NORMAL: 1, MAGIC: 3, RARE: 6, UNIQUE: 0 })[rarity];
export function dismantlePermission(
  die: Pick<DieDTO, 'id' | 'isStarter' | 'isLocked' | 'isEquipped' | 'rarity'>,
  activeRunDieId: string | null,
): ItemPermission {
  const reason = die.isStarter
    ? 'Стартовый кубик нельзя распылить.'
    : die.isLocked
      ? 'Сначала снимите защиту кубика.'
      : die.isEquipped
        ? 'Сначала экипируйте другой кубик.'
        : die.id === activeRunDieId
          ? 'Кубик используется в незавершённом походе.'
          : die.rarity === 'UNIQUE'
            ? 'Уникальные кубики пока нельзя распылять.'
            : null;
  return { allowed: reason === null, reason };
}
