import type { MapNodeType, RunDTO } from '@dicebound/shared-types';
import { demoHub } from './demo';
/** Fixed, read-only example. No client RNG, progression, combat calculation or API bypass. */
export function demoRun(): RunDTO {
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
  return {
    id: 'demo-run',
    revision: 0,
    mode: 'TRAINING',
    status: 'IN_PROGRESS',
    currentNodeId: 'f2-1',
    visitedNodeIds: ['start', 'f1-0', 'f2-1'],
    availableNodeIds: [],
    nodes: rows.flatMap((types, depth) =>
      types.map((type, lane) => ({
        id: depth === 0 ? 'start' : `f${depth}-${lane}`,
        depth,
        lane,
        type,
        next: depth === 7 ? [] : rows[depth + 1]!.map((_, i) => `f${depth + 1}-${i}`),
      })),
    ),
    loadout: demoHub().inventory.dice[0]!,
    playerHp: 44,
    playerMaxHp: 50,
    loot: { gold: 4, dust: 1 },
    reward: null,
    battle: {
      id: 'demo-battle',
      state: 'AWAITING_DECISION',
      currentRolledFace: 4,
      focusCharges: 1,
      rerollsLeft: 1,
      turnNumber: 2,
      playerHp: 44,
      playerMaxHp: 50,
      playerShield: 0,
      enemyType: 'SPEARMAN',
      enemyName: 'Гоблин-копейщик',
      enemyHp: 10,
      enemyMaxHp: 14,
      enemyShield: 0,
      currentIntent: {
        kind: 'WINDUP',
        label: 'Замах — следующий удар усилен',
        value: 0,
        baseValue: 0,
        heal: 0,
        poison: 0,
        thorns: 0,
        lifestealPercent: 0,
      },
      effects: {
        playerPoison: { damage: 0, turns: 0 },
        enemyPoison: { damage: 0, turns: 0 },
        weaknessTurns: 0,
        enemyThorns: 0,
      },
      outcome: null,
      log: [{ turn: 1, message: 'Грань 1: атака 4 — разыграть.' }],
      options: {
        direct: { face: 4, action: 'PIERCE', value: 5 },
        shift: { face: 4, action: 'GUARD', value: 3 },
        flip: { face: 3, action: 'STRIKE', value: 6 },
      },
    },
  };
}
