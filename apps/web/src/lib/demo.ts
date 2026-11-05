import type { HubDTO } from '@dicebound/shared-types';

/** UI-only fixture. It never enters the API, database, or Telegram auth path. */
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
      tutorialDone: false,
    },
    inventory: {
      capacity: 12,
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
