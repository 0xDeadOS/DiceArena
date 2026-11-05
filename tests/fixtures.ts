import { createHmac } from 'node:crypto';
import {
  starterFaces,
  STARTING_SPHERES,
  calculatePowerScore,
} from '../packages/game-core/src/index.js';
import type { HubDTO, RoomContext } from '../packages/shared-types/src/index.js';

export const TEST_TOKEN = '123456789:only_for_tests_not_a_real_bot_token';
export const NOW = new Date('2026-11-04T12:00:00Z');
export const ROOM: RoomContext = {
  id: 'e2ce36c7-23fb-4988-a0cc-6337e7866101',
  slug: 'r_abcdefgh',
  title: 'Обитель друзей',
  telegramChatId: -1001234567890n,
};

export function signedInitData(fields: Record<string, string | null> = {}, token = TEST_TOKEN) {
  const values: Record<string, string | null> = {
    auth_date: String(Math.floor(NOW.getTime() / 1000)),
    start_param: ROOM.slug,
    user: JSON.stringify({ id: 42, first_name: 'Алиса', username: 'alice' }),
    query_id: 'test-query',
    ...fields,
  };
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== null) params.set(key, value);
  const check = [...params.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

export function fixtureHub(): HubDTO {
  return {
    room: { id: ROOM.id, slug: ROOM.slug, title: ROOM.title, memberCount: 1, sealFragments: 0 },
    player: {
      id: 'ec38c021-7496-43b7-b571-0847df2b44d8',
      firstName: 'Алиса',
      username: 'alice',
      gold: 150,
      facetDust: 0,
      inventoryRevision: 0,
      sealFragments: 0,
      equippedDieId: '0d41408b-c36e-4703-b43b-1ca7bb230f08',
      vigor: { current: 3, maximum: 6, nextRestoreAt: '2026-11-05T00:00:00.000Z' },
      tutorialDone: false,
      tutorial: { trainingWon: false, crafted: false, rewardClaimed: false, step: 'TRAINING' },
      highestExpeditionLevel: 0,
    },
    inventory: {
      capacity: 12,
      pendingDrops: [],
      dice: [
        {
          id: '0d41408b-c36e-4703-b43b-1ca7bb230f08',
          contentVersion: 0,
          effectiveFaces: starterFaces(),
          baseType: 'BONE',
          ilvl: 1,
          quality: 0,
          rarity: 'NORMAL',
          faces: starterFaces(),
          affixes: [],
          powerScore: calculatePowerScore(starterFaces(), 0),
          isStarter: true,
          isLocked: false,
          isEquipped: true,
          masterCrafted: false,
        },
      ],
      spheres: Object.entries(STARTING_SPHERES).map(([type, amount]) => ({
        type: type as keyof typeof STARTING_SPHERES,
        amount,
      })),
    },
    activeRun: null,
    raid: null,
  };
}
