import { describe, it, expect } from 'vitest';
import { battleFace, newSecretSeed, secretInt } from './random.js';
describe('server-only HMAC RNG', () => {
  it('generates independent 256-bit seeds', () => {
    const seed = newSecretSeed();
    expect(seed).toMatch(/^[a-f0-9]{64}$/);
    expect(seed).not.toBe(newSecretSeed());
  });
  it('replays by seed/counter and domain-separates map draws', () => {
    const seed = 'ab'.repeat(32);
    const first = Array.from({ length: 50 }, (_, i) => battleFace(seed, i));
    expect(first).toEqual(Array.from({ length: 50 }, (_, i) => battleFace(seed, i)));
    expect(new Set(first)).toEqual(new Set([1, 2, 3, 4, 5, 6]));
    expect(first).not.toEqual(
      Array.from({ length: 50 }, (_, i) => secretInt(seed, 'map', i, 6) + 1),
    );
  });
  it('bounds every draw and rejects invalid inputs', () => {
    const seed = '00'.repeat(32);
    for (let i = 0; i < 500; i++) {
      const roll = battleFace(seed, i);
      expect(roll).toBeGreaterThanOrEqual(1);
      expect(roll).toBeLessThanOrEqual(6);
    }
    expect(secretInt(seed, 'test', 0, 1)).toBe(0);
    for (const bad of [0, -1, 1.5, Infinity, 0x100000001])
      expect(() => secretInt(seed, 'test', 0, bad)).toThrow();
    expect(() => battleFace('public-seed', 0)).toThrow();
    expect(() => battleFace(seed, -1)).toThrow();
  });
});
