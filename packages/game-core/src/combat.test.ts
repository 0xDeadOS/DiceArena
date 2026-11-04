import { describe, it, expect } from 'vitest';
import { ENEMY_TYPES } from '@dicebound/shared-types';
import type { CombatDie, CombatState, EnemyType } from '@dicebound/shared-types';
import {
  starterFaces,
  AFFIXES,
  combatDieSchema,
  combatStats,
  facePlay,
  newCombat,
  rollCombat,
  combatOptions,
  decideCombat,
  hit,
  enemyIntent,
  trainingMap,
  trainingReward,
  settleLoot,
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
};
function affixed(...ids: string[]): CombatDie {
  return {
    ...die,
    ilvl: 20,
    rarity: ids.length > 2 ? 'RARE' : 'MAGIC',
    affixes: ids.map((id) => ({
      id,
      kind: AFFIXES[id]!.kind,
      tier: 3,
      value: AFFIXES[id]!.ranges[2][0],
    })),
  };
}
const start = (type: EnemyType = 'SLIME', loadout = die) =>
  newCombat(type, loadout, combatStats(loadout).maxHp, combatStats(loadout).maxHp);
const ready = (face = 1, loadout = die, type: EnemyType = 'SLIME') =>
  rollCombat(start(type, loadout), face);
const inert = (state: CombatState) => ({
  ...state,
  currentIntent: enemyIntent('SPEARMAN', 2, 10, 10, 0),
});
describe('combat loadouts', () => {
  it('accepts only six distinct faces and supported rarity/affix combinations', () => {
    expect(combatDieSchema.parse(die)).toEqual(die);
    expect(
      combatDieSchema.safeParse({ ...die, faces: die.faces.map(() => die.faces[0]) }).success,
    ).toBe(false);
    expect(combatDieSchema.safeParse({ ...die, rarity: 'UNIQUE' }).success).toBe(false);
    expect(combatDieSchema.safeParse({ ...die, affixes: affixed('P1').affixes }).success).toBe(
      false,
    );
    expect(combatDieSchema.safeParse({ ...affixed('P1'), ilvl: 19 }).success).toBe(false);
    expect(combatDieSchema.safeParse(affixed('P1', 'P1')).success).toBe(false);
    expect(combatDieSchema.safeParse(affixed('P1', 'P2', 'P3')).success).toBe(false);
  });
  it.each(['UNKNOWN', '__proto__', 'constructor', 'toString'])(
    'rejects unknown affix %s without throwing from the validator',
    (id) => {
      const item = { ...affixed('P1'), affixes: [{ id, kind: 'PREFIX', tier: 1, value: 1 }] };
      expect(combatDieSchema.safeParse(item).success).toBe(false);
    },
  );
  it.each(Object.keys(AFFIXES))('validates all tier ranges and kind for %s', (id) => {
    const def = AFFIXES[id]!;
    for (const tier of [1, 2, 3] as const) {
      const [low, high] = def.ranges[tier - 1]!;
      const item = {
        ...die,
        rarity: 'MAGIC',
        ilvl: [1, 10, 20][tier - 1],
        affixes: [{ id, kind: def.kind, tier, value: low }],
      };
      expect(combatDieSchema.safeParse(item).success).toBe(true);
      expect(
        combatDieSchema.safeParse({ ...item, affixes: [{ ...item.affixes[0], value: high }] })
          .success,
      ).toBe(true);
      expect(
        combatDieSchema.safeParse({ ...item, affixes: [{ ...item.affixes[0], value: high + 1 }] })
          .success,
      ).toBe(false);
      expect(
        combatDieSchema.safeParse({
          ...item,
          affixes: [{ ...item.affixes[0], kind: def.kind === 'PREFIX' ? 'SUFFIX' : 'PREFIX' }],
        }).success,
      ).toBe(false);
    }
  });
  it('applies base, quality, flat then additive percent, without rarity multiplier', () => {
    const item = { ...affixed('P2', 'P4'), quality: 20, baseType: 'IRON' as const };
    expect(facePlay(item, 2).value).toBe(Math.floor((5 * 1.2 + 4 + 1) * 1.26));
    expect(facePlay({ ...item, baseType: 'OBSIDIAN' }, 2).value).toBe(
      Math.floor((5 * 1.2 + 4) * 1.31),
    );
    expect(facePlay(affixed('P5', 'P7'), 6).value).toBe(20);
    expect(facePlay(affixed('P1', 'P3'), 1).value).toBe(10);
    expect(facePlay(affixed('P1', 'P3'), 4).value).toBe(6);
  });
  it('initializes HP, rerolls, and focus from suffixes', () => {
    expect(combatStats(affixed('P1', 'S7', 'S2')).maxHp).toBe(80);
    expect(combatStats(affixed('P1', 'S7', 'S2')).rerolls).toBe(4);
    expect(start('SLIME', affixed('S3')).focusCharges).toBe(3);
  });
});
describe('server-owned combat state machine', () => {
  it('persists a roll without changing HP, focus, turn or intent and rejects a second roll', () => {
    const state = start();
    const rolled = rollCombat(state, 1);
    expect(rolled).toMatchObject({
      state: 'AWAITING_DECISION',
      currentRolledFace: 1,
      turnNumber: 1,
      focusCharges: 0,
      currentIntent: state.currentIntent,
    });
    expect(state.state).toBe('AWAITING_ROLL');
    expect(() => rollCombat(rolled, 2)).toThrow();
    expect(() => rollCombat(state, 7)).toThrow();
    expect(() => decideCombat(state, die, 'DIRECT')).toThrow();
  });
  it('DIRECT applies the face, adds one focus and resolves the announced enemy turn', () => {
    const state = ready();
    const before = structuredClone(state);
    const next = decideCombat(state, die, 'DIRECT');
    expect(next).toMatchObject({
      state: 'AWAITING_ROLL',
      currentRolledFace: null,
      focusCharges: 1,
      enemyHp: 8,
      playerHp: 47,
      turnNumber: 2,
    });
    expect(next.currentIntent.kind).toBe('GUARD');
    expect(state).toEqual(before);
    expect(decideCombat({ ...state, focusCharges: 3 }, die, 'DIRECT').focusCharges).toBe(3);
  });
  it('SHIFT commits at ceil(50%), awards no focus, and cannot convert Heal', () => {
    expect(combatOptions(ready(2), die)?.shift).toEqual({ face: 2, action: 'STRIKE', value: 3 });
    expect(decideCombat(ready(2), die, 'SHIFT')).toMatchObject({
      enemyHp: 9,
      playerHp: 47,
      focusCharges: 0,
      turnNumber: 2,
    });
    expect(combatOptions(ready(1, affixed('S6')), affixed('S6'))?.shift?.value).toBe(4);
    expect(combatOptions(ready(5), die)?.shift).toBeNull();
    expect(() => decideCombat(ready(5), die, 'SHIFT')).toThrow();
  });
  it('FLIP commits opposite face immediately, spends one focus, and never refunds focus', () => {
    expect(() => decideCombat(ready(), die, 'FLIP')).toThrow();
    const result = decideCombat({ ...ready(), focusCharges: 1 }, die, 'FLIP');
    expect(result).toMatchObject({
      focusCharges: 0,
      playerHp: 50,
      enemyHp: 12,
      turnNumber: 2,
      state: 'AWAITING_ROLL',
    });
    expect(result.log[0]?.message).toContain('Грань 6');
  });
  it('REROLL spends a charge, preserves intent/effects/turn and stays awaiting decision', () => {
    const state = { ...ready(), focusCharges: 2, playerShield: 9 };
    state.effects.playerPoison = { damage: 3, turns: 3 };
    const result = decideCombat(state, die, 'REROLL', 5);
    expect(result).toMatchObject({
      state: 'AWAITING_DECISION',
      currentRolledFace: 5,
      rerollsLeft: 0,
      focusCharges: 2,
      playerHp: 50,
      playerShield: 9,
      turnNumber: 1,
      effects: state.effects,
      currentIntent: state.currentIntent,
    });
    expect(() => decideCombat(result, die, 'REROLL', 2)).toThrow();
    expect(() => decideCombat(state, die, 'REROLL')).toThrow();
  });
  it('ends a killing blow before enemy retaliation and prevents further actions', () => {
    const state = { ...ready(), enemyHp: 4 };
    const result = decideCombat(state, die, 'DIRECT');
    expect(result).toMatchObject({
      state: 'FINISHED',
      outcome: 'VICTORY',
      playerHp: 50,
      currentRolledFace: null,
    });
    expect(() => rollCombat(result, 1)).toThrow();
    expect(() => decideCombat(result, die, 'DIRECT')).toThrow();
  });
  it('caps healing at max HP; defeat clears the face and cannot be replayed', () => {
    expect(decideCombat(inert({ ...ready(5), playerHp: 49 }), die, 'DIRECT').playerHp).toBe(50);
    expect(decideCombat({ ...ready(), playerHp: 1 }, die, 'DIRECT')).toMatchObject({
      state: 'FINISHED',
      outcome: 'DEFEAT',
      playerHp: 0,
      currentRolledFace: null,
    });
  });
  it('Pierce ignores half of shield capacity and does not trigger enemy thorns', () => {
    expect(hit(20, 10, 8, 5)).toEqual({ hp: 17, shield: 5, hpDamage: 3 });
    const state = inert({ ...ready(4), enemyShield: 5 });
    state.effects.enemyThorns = 9;
    expect(decideCombat(state, die, 'DIRECT')).toMatchObject({ enemyHp: 9, playerHp: 50 });
    expect(decideCombat({ ...state, currentRolledFace: 1 }, die, 'DIRECT').playerHp).toBe(41);
    expect(decideCombat({ ...state, currentRolledFace: 1 }, affixed('P8'), 'DIRECT').enemyHp).toBe(
      8,
    );
  });
  it('lifesteal uses actual HP damage, not absorbed or overkill damage', () => {
    const item = affixed('S1');
    const state = inert({ ...ready(3, item), playerHp: 30, enemyShield: 4 });
    expect(decideCombat(state, item, 'DIRECT').playerHp).toBe(30);
    expect(decideCombat({ ...state, enemyShield: 0 }, item, 'DIRECT').playerHp).toBe(31);
    expect(decideCombat({ ...state, enemyShield: 0, enemyHp: 1 }, item, 'DIRECT').playerHp).toBe(
      30,
    );
  });
  it('thorns require player shield; simultaneous death is defeat', () => {
    const item = affixed('P6');
    expect(decideCombat(ready(2, item), item, 'DIRECT').enemyHp).toBe(3);
    expect(decideCombat(ready(1, item), item, 'DIRECT').enemyHp).toBe(8);
    const state = {
      ...ready(2, item),
      playerHp: 1,
      enemyHp: 9,
      currentIntent: { ...ready().currentIntent, value: 9 },
    };
    expect(decideCombat(state, item, 'DIRECT').outcome).toBe('DEFEAT');
  });
  it('poison stacks, refreshes three turns, bypasses shields and ticks before enemy action', () => {
    const item = affixed('S4');
    const state = inert(ready(4, item));
    state.effects.enemyPoison = { damage: 2, turns: 1 };
    const result = decideCombat({ ...state, enemyHp: 30, enemyMaxHp: 30 }, item, 'DIRECT');
    expect(result.enemyHp).toBe(16);
    expect(result.effects.enemyPoison).toEqual({ damage: 9, turns: 2 });
    const kill = decideCombat(ready(4, item), item, 'DIRECT');
    expect(kill.outcome).toBe('VICTORY');
    expect(kill.playerHp).toBe(50);
    const poisoned = { ...ready(2), playerHp: 2, playerShield: 100 };
    poisoned.effects.playerPoison = { damage: 2, turns: 1 };
    expect(decideCombat(poisoned, die, 'DIRECT')).toMatchObject({
      outcome: 'DEFEAT',
      playerHp: 0,
      effects: { playerPoison: { damage: 0, turns: 0 } },
    });
  });
  it('rat poison only lands on HP damage and starts ticking next committed turn', () => {
    expect(
      decideCombat(ready(2, die, 'PLAGUE_RAT'), die, 'DIRECT').effects.playerPoison.damage,
    ).toBe(0);
    const result = decideCombat(ready(1, die, 'PLAGUE_RAT'), die, 'DIRECT');
    expect(result).toMatchObject({
      playerHp: 48,
      effects: { playerPoison: { damage: 1, turns: 3 } },
    });
  });
  it('applies weakness to final attacking actions, expires on commit, not on reroll', () => {
    const state = ready(1);
    state.effects.weaknessTurns = 1;
    expect(combatOptions(state, die)).toMatchObject({ direct: { value: 2 }, shift: { value: 2 } });
    expect(combatOptions({ ...state, currentRolledFace: 2 }, die)?.shift?.value).toBe(2);
    expect(decideCombat(state, die, 'REROLL', 2).effects.weaknessTurns).toBe(1);
    expect(decideCombat(state, die, 'DIRECT').effects.weaknessTurns).toBe(0);
  });
  it('shield retention happens once at the next-turn boundary, not on roll or reroll', () => {
    const item = affixed('S5');
    const result = decideCombat(inert(ready(6, item)), item, 'DIRECT');
    expect(result.playerShield).toBe(3);
    expect(rollCombat(result, 1).playerShield).toBe(3);
    expect(decideCombat(rollCombat(result, 1), item, 'REROLL', 2).playerShield).toBe(3);
    expect(decideCombat(inert(ready(6)), die, 'DIRECT').playerShield).toBe(0);
  });
  it('Shield Bash reacts to remaining shield; boss fury never rewrites an announced hit', () => {
    const stone = ready(1, die, 'STONE_GUARD');
    stone.enemyShield = 6;
    stone.currentIntent = enemyIntent('STONE_GUARD', 2, 27, 27, 6);
    expect(decideCombat(stone, die, 'DIRECT').playerHp).toBe(43);
    const king = ready(3, die, 'BONE_KING');
    king.enemyHp = 23;
    expect(king.currentIntent.value).toBe(5);
    const result = decideCombat(king, die, 'DIRECT');
    expect(result.playerHp).toBe(45);
    expect(enemyIntent('BONE_KING', 3, 17, 45, 0).value).toBe(8);
  });
  it('priest steals only HP damage and logs stay bounded', () => {
    const state = { ...ready(5, die, 'BLOOD_PRIEST'), enemyHp: 10 };
    state.log = Array.from({ length: 20 }, () => ({ turn: 0, message: 'old' }));
    const result = decideCombat(state, die, 'DIRECT');
    expect(result.enemyHp).toBe(12);
    expect(result.log).toHaveLength(20);
    expect(decideCombat({ ...state, currentRolledFace: 6 }, die, 'DIRECT').enemyHp).toBe(10);
  });
  it.each(ENEMY_TYPES)(
    'keeps all state invariants during deterministic simulations against %s',
    (type) => {
      for (let offset = 0; offset < 6; offset++) {
        let state = start(type);
        let turns = 0;
        while (state.state !== 'FINISHED' && turns++ < 300) {
          state = rollCombat(state, ((turns + offset) % 6) + 1);
          state = decideCombat(
            state,
            die,
            combatOptions(state, die)?.direct.action === 'GUARD' ? 'SHIFT' : 'DIRECT',
          );
          expect(state.playerHp).toBeGreaterThanOrEqual(0);
          expect(state.playerHp).toBeLessThanOrEqual(state.playerMaxHp);
          expect(state.enemyHp).toBeGreaterThanOrEqual(0);
          expect(state.enemyHp).toBeLessThanOrEqual(state.enemyMaxHp);
          expect(state.focusCharges).toBeLessThanOrEqual(3);
          expect(state.log.length).toBeLessThanOrEqual(20);
        }
        expect(state.state).toBe('FINISHED');
      }
    },
  );
});
describe('training maps and settlement', () => {
  it('always has seven reachable depths, max two lanes and no backward edges', () => {
    for (const draw of [() => 0, () => 1]) {
      const map = trainingMap(draw);
      expect(map).toHaveLength(13);
      expect(new Set(map.map((n) => n.id)).size).toBe(map.length);
      for (const node of map)
        for (const next of node.next)
          expect(map.find((n) => n.id === next)?.depth).toBe(node.depth + 1);
      for (let depth = 0; depth <= 7; depth++)
        expect(map.filter((n) => n.depth === depth).length).toBeLessThanOrEqual(2);
      expect(map.find((n) => n.depth === 7)).toMatchObject({ type: 'BOSS', next: [] });
    }
  });
  it('gives only small gold/dust; defeat or retreat keeps floor 40% of accumulated loot', () => {
    expect(trainingReward('BOSS')).toEqual({ gold: 12, dust: 3 });
    expect(trainingReward('CAMP')).toEqual({ gold: 0, dust: 0 });
    expect(settleLoot({ gold: 11, dust: 3 }, false)).toEqual({ gold: 4, dust: 1 });
    expect(settleLoot({ gold: 11, dust: 3 }, true)).toEqual({ gold: 11, dust: 3 });
  });
});
