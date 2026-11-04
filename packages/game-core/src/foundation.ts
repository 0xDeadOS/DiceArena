import type { DieFace, SphereType } from '@dicebound/shared-types';

export const INVENTORY_CAPACITY = 12;
export const STARTING_GOLD = 150;
export const STARTING_VIGOR = 3;
export const MAX_VIGOR = 6;
export const DAILY_VIGOR = 3;
export const DAY_MS = 86_400_000;

export const STARTING_SPHERES: Readonly<Record<SphereType, number>> = Object.freeze({
  TEMPERING: 2,
  FACETING: 1,
  CASTING: 3,
  ASCENDANCE: 0,
  RESHAPING: 0,
  CLEANSING: 0,
});

export function starterFaces(): DieFace[] {
  return [
    { face: 1, action: 'STRIKE', value: 4 },
    { face: 2, action: 'GUARD', value: 5 },
    { face: 3, action: 'STRIKE', value: 6 },
    { face: 4, action: 'PIERCE', value: 5 },
    { face: 5, action: 'HEAL', value: 3 },
    { face: 6, action: 'GUARD', value: 7 },
  ];
}

export function oppositeFace(face: number): number {
  if (!Number.isInteger(face) || face < 1 || face > 6) throw new RangeError('Face must be 1..6');
  return 7 - face;
}

export interface FaceBonuses {
  flat?: number;
  percent?: number;
}

export function effectiveFaceValue(
  base: number,
  quality: number,
  bonuses: FaceBonuses = {},
): number {
  const { flat = 0, percent = 0 } = bonuses;
  if (
    ![base, quality, flat, percent].every(Number.isFinite) ||
    base < 0 ||
    quality < 0 ||
    quality > 20
  ) {
    throw new RangeError('Invalid face values');
  }
  return Math.max(0, Math.floor((base * (1 + quality / 100) + flat) * (1 + percent / 100)));
}

/**
 * v2 ETV × 10, with synergy evaluated per opposing pair. No rarity multiplier.
 * Callers supply resolved face bonuses and passive EV explicitly. Automatic
 * passive-EV calibration is intentionally deferred until crafting/rating balance.
 */
export function calculatePowerScore(
  faces: readonly DieFace[],
  quality: number,
  faceBonuses: Readonly<Partial<Record<number, FaceBonuses>>> = {},
  passiveAffixEV = 0,
): number {
  if (faces.length !== 6 || new Set(faces.map((face) => face.face)).size !== 6) {
    throw new RangeError('A die must contain six distinct faces');
  }
  if (!Number.isFinite(passiveAffixEV) || passiveAffixEV < 0)
    throw new RangeError('Invalid passive EV');
  const total = faces.reduce((sum, face) => {
    const opposite = faces.find((other) => other.face === oppositeFace(face.face));
    if (!opposite) throw new RangeError('Missing opposite face');
    const synergy = opposite.action !== face.action ? 1.1 : 1;
    return sum + effectiveFaceValue(face.value, quality, faceBonuses[face.face]) * synergy;
  }, 0);
  return Math.round(10 * (total / 6 + passiveAffixEV));
}

/** Lazy UTC-day refill: no cron, no drift, at most six saved points. */
export function refreshVigor(stored: number, updatedAt: Date, now: Date) {
  if (!Number.isInteger(stored) || stored < 0 || stored > MAX_VIGOR)
    throw new RangeError('Invalid vigor');
  if (![updatedAt.getTime(), now.getTime()].every(Number.isFinite))
    throw new RangeError('Invalid date');
  const currentDay = Math.floor(now.getTime() / DAY_MS);
  const previousDay = Math.floor(updatedAt.getTime() / DAY_MS);
  const days = Math.max(0, currentDay - previousDay);
  return {
    current: Math.min(MAX_VIGOR, stored + days * DAILY_VIGOR),
    updatedAt: days > 0 ? new Date(currentDay * DAY_MS) : updatedAt,
    nextRestoreAt: new Date((Math.max(currentDay, previousDay) + 1) * DAY_MS),
  };
}
