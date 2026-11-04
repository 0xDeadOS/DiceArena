import type { RunDTO } from '@dicebound/shared-types';
import { combatOptions, newCombat, rollCombat, trainingMap } from '@dicebound/game-core';
import { fixtureHub } from './fixtures.js';
export function fixtureRun(decision = true): RunDTO {
  const loadout = fixtureHub().inventory.dice[0]!;
  const initial = newCombat('SLIME', loadout, 50, 50);
  const state = decision ? rollCombat(initial, 4) : initial;
  return {
    id: '10000000-0000-4000-8000-000000000001',
    revision: decision ? 2 : 1,
    mode: 'TRAINING',
    status: 'IN_PROGRESS',
    currentNodeId: 'f1-0',
    visitedNodeIds: ['start', 'f1-0'],
    availableNodeIds: [],
    nodes: trainingMap(() => 0),
    playerHp: 50,
    playerMaxHp: 50,
    loadout,
    loot: { gold: 0, dust: 0 },
    reward: null,
    battle: {
      id: '20000000-0000-4000-8000-000000000001',
      ...state,
      enemyName: 'Пещерный слизень',
      options: combatOptions(state, loadout),
    },
  };
}
