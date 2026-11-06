import { createHmac, randomBytes } from 'node:crypto';
export const newSecretSeed = () => randomBytes(32).toString('hex');
/** Server-only domain-separated HMAC counter PRNG with rejection sampling. */
export function secretInt(
  seed: string,
  domain: string,
  step: number,
  exclusiveMax: number,
): number {
  if (
    !/^[a-f0-9]{64}$/.test(seed) ||
    !Number.isSafeInteger(step) ||
    step < 0 ||
    !Number.isSafeInteger(exclusiveMax) ||
    exclusiveMax < 1 ||
    exclusiveMax > 0x100000000
  )
    throw new RangeError('Invalid RNG input');
  const limit = Math.floor(0x100000000 / exclusiveMax) * exclusiveMax;
  for (let retry = 0; ; retry++) {
    const value = createHmac('sha256', Buffer.from(seed, 'hex'))
      .update(`dicebound:v1:${domain}:${step}:${retry}`)
      .digest()
      .readUInt32BE(0);
    if (value < limit) return value % exclusiveMax;
  }
}
export const battleFace = (seed: string, step: number) =>
  secretInt(seed, 'battle-roll', step, 6) + 1;
