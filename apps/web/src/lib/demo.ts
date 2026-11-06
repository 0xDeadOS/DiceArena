import { calculatePowerScore } from '@dicebound/game-core';
import type { DieDTO, HubDTO } from '@dicebound/shared-types';

/** UI-only fixture. It never enters the API, database, or Telegram auth path. */
/** UI-only fixture. Server RNG never runs in the browser preview. */
function demoDie(id: string): DieDTO {
  const faces = [
    { face: 1, action: 'STRIKE' as const, value: 7 },
    { face: 2, action: 'GUARD' as const, value: 8 },
    { face: 3, action: 'PIERCE' as const, value: 6 },
    { face: 4, action: 'HEAL' as const, value: 3 },
    { face: 5, action: 'STRIKE' as const, value: 9 },
    { face: 6, action: 'GUARD' as const, value: 10 },
  ];
  return {
    id,
    contentVersion: 0,
    effectiveFaces: faces,
    baseType: 'IRON',
    ilvl: 2,
    quality: 0,
    rarity: 'NORMAL',
    powerScore: calculatePowerScore(faces, 0),
    isStarter: false,
    isLocked: false,
    isEquipped: false,
    masterCrafted: false,
    affixes: [],
    faces,
  };
}
export function demoHub(): HubDTO {
  return {
    room: {
      id: 'demo-room',
      slug: 'r_demo0000',
      title: 'Тихий союз',
      memberCount: 6,
      sealFragments: 0,
    },
    player: {
      id: 'demo-player',
      firstName: 'Странник',
      username: null,
      gold: 150,
      facetDust: 0,
      inventoryRevision: 0,
      sealFragments: 0,
      equippedDieId: 'demo-die',
      vigor: {
        current: 3,
        maximum: 6,
        nextRestoreAt: new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate() + 1,
          ),
        ).toISOString(),
      },
      tutorialDone: true,
      tutorial: { trainingWon: true, crafted: true, rewardClaimed: true, step: 'DONE' },
      highestExpeditionLevel: 2,
    },
    inventory: {
      capacity: 12,
      pendingDrops: [
        {
          id: 'demo-drop',
          runId: 'demo-run',
          dust: 1,
          take: { allowed: true, reason: null },
          item: demoDie('demo-drop'),
        },
      ],
      dice: [
        {
          id: 'demo-die',
          contentVersion: 0,
          effectiveFaces: [
            { face: 1, action: 'STRIKE', value: 4 },
            { face: 2, action: 'GUARD', value: 5 },
            { face: 3, action: 'STRIKE', value: 6 },
            { face: 4, action: 'PIERCE', value: 5 },
            { face: 5, action: 'HEAL', value: 3 },
            { face: 6, action: 'GUARD', value: 7 },
          ],
          baseType: 'BONE',
          ilvl: 1,
          quality: 0,
          rarity: 'NORMAL',
          powerScore: 55,
          isStarter: true,
          isLocked: false,
          isEquipped: true,
          masterCrafted: false,
          affixes: [],
          faces: [
            { face: 1, action: 'STRIKE', value: 4 },
            { face: 2, action: 'GUARD', value: 5 },
            { face: 3, action: 'STRIKE', value: 6 },
            { face: 4, action: 'PIERCE', value: 5 },
            { face: 5, action: 'HEAL', value: 3 },
            { face: 6, action: 'GUARD', value: 7 },
          ],
        },
      ],
      spheres: [
        { type: 'TEMPERING', amount: 2 },
        { type: 'FACETING', amount: 1 },
        { type: 'CASTING', amount: 3 },
        { type: 'ASCENDANCE', amount: 0 },
        { type: 'RESHAPING', amount: 0 },
        { type: 'CLEANSING', amount: 0 },
      ],
    },
    activeRun: null,
    raid: null,
  };
}
