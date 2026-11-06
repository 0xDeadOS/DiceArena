import { describe, expect, it } from 'vitest';
import type { DieFace } from '@dicebound/shared-types';
import {
  calculatePowerScore,
  effectiveFaceValue,
  oppositeFace,
  refreshVigor,
  starterFaces,
  STARTING_SPHERES,
} from './index.js';

describe('v2 starter kit and formulas', () => {
  it('creates a working 55 PS die with distinct faces and tactical pairs', () => {
    expect(starterFaces()).toHaveLength(6);
    expect(calculatePowerScore(starterFaces(), 0)).toBe(55);
    expect(STARTING_SPHERES).toEqual({
      CASTING: 3,
      TEMPERING: 2,
      FACETING: 1,
      ASCENDANCE: 0,
      RESHAPING: 0,
      CLEANSING: 0,
    });
  });
  it('does not share mutable starter faces between users', () => {
    const faces = starterFaces();
    faces[0]!.value = 999;
    expect(starterFaces()[0]!.value).toBe(4);
  });
  it.each([1, 2, 3, 4, 5, 6])('opposite of %i sums to seven and is reversible', (face) => {
    expect(face + oppositeFace(face)).toBe(7);
    expect(oppositeFace(oppositeFace(face))).toBe(face);
  });
  it.each([0, 7, 1.5, NaN])('rejects invalid face %s', (face) =>
    expect(() => oppositeFace(face)).toThrow(),
  );
  it('rounds down only after quality, flat and percentage bonuses', () => {
    expect(effectiveFaceValue(8, 10, { flat: 1, percent: 15 })).toBe(11);
    expect(effectiveFaceValue(10, 20)).toBe(12);
  });
  it('calculates pair synergy per face, and accepts explicit passive EV', () => {
    const same: DieFace[] = starterFaces().map((face) => ({
      ...face,
      action: 'STRIKE' as const,
      value: 5,
    }));
    expect(calculatePowerScore(same, 0)).toBe(50);
    expect(calculatePowerScore(same, 0, {}, 2)).toBe(70);
    same[0]!.action = 'GUARD';
    expect(calculatePowerScore(same, 0)).toBe(52);
  });
  it('rejects malformed dice rather than scoring them', () => {
    expect(() => calculatePowerScore(starterFaces().slice(1), 0)).toThrow();
    expect(() =>
      calculatePowerScore([...starterFaces().slice(1), starterFaces()[1]!], 0),
    ).toThrow();
    expect(() => effectiveFaceValue(5, 25)).toThrow();
  });
});

describe('lazy UTC vigor refill', () => {
  it('does not refill twice in the same day', () => {
    expect(
      refreshVigor(0, new Date('2026-11-04T00:00:00Z'), new Date('2026-11-04T23:59:59Z')).current,
    ).toBe(0);
  });
  it('adds three at midnight and caps long absences at six', () => {
    expect(
      refreshVigor(1, new Date('2026-11-04T23:59:59Z'), new Date('2026-11-05T00:00:00Z')).current,
    ).toBe(4);
    expect(
      refreshVigor(0, new Date('2026-10-01T00:00:00Z'), new Date('2026-11-04T00:00:00Z')).current,
    ).toBe(6);
  });
  it('does not mint vigor when the clock goes backwards', () => {
    const updated = new Date('2026-11-05T00:00:00Z');
    const result = refreshVigor(1, updated, new Date('2026-11-04T00:00:00Z'));
    expect(result.current).toBe(1);
    expect(result.updatedAt).toEqual(updated);
  });
});
