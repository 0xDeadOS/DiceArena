import { createHmac } from 'node:crypto';
import {
  starterFaces,
  STARTING_SPHERES,
  calculatePowerScore,
} from '../packages/game-core/src/index.js';
import type {
  HubDTO,
  LeaderboardDTO,
  RaidDTO,
  RoomContext,
} from '../packages/shared-types/src/index.js';

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

/** Снимок рейда для HTTP-тестов: активный босс, открытый удар, собранный алтарь. */
export function fixtureRaid(): RaidDTO {
  return {
    altar: { fragments: 15, target: 15, ready: true },
    myFragments: 2,
    hornsLeft: 2,
    raid: {
      id: '5a2f6f0a-4c1e-4c2a-9b1d-2b7f6b0a1c01',
      bossName: 'Костяной патриарх',
      status: 'ACTIVE',
      phase: 2,
      rounds: Array.from({ length: 6 }, (_, index) => ({
        round: index + 1,
        shield: Math.ceil((index + 1) / 2),
        cleared: index === 0,
      })),
      currentHp: 5,
      roundHp: 8,
      shield: 1,
      maxHp: 48,
      revision: 4,
      createdAt: NOW.toISOString(),
      expiresAt: new Date(NOW.getTime() + 47 * 3_600_000).toISOString(),
      defeatedAt: null,
      myDamage: 6,
      totalDamage: 6,
      contributions: [{ memberId: 'member-1', firstName: 'Алиса', damage: 6, attacks: 1 }],
      attack: {
        id: '5a2f6f0a-4c1e-4c2a-9b1d-2b7f6b0a1c02',
        round: 2,
        rollsUsed: 1,
        rerollsLeft: 1,
        focusCharges: 0,
        state: 'AWAITING_DECISION',
        currentRolledFace: 4,
        options: {
          direct: { face: 4, action: 'STRIKE', value: 9 },
          shift: { face: 4, action: 'GUARD', value: 5 },
          flip: null,
        },
        action: null,
        faceValue: null,
        damageDealt: 0,
      },
      trophy: { available: false, claimedByMe: false },
    },
    canContribute: { allowed: false, reason: 'Алтарь печати уже полон.' },
    canSummon: { allowed: false, reason: 'Рейд Обители уже идёт.' },
    canAttack: { allowed: true, reason: null },
    canClaimTrophy: {
      allowed: false,
      reason: 'Трофей появляется после победы над боссом.',
    },
  };
}

export function fixtureLeaderboard(): LeaderboardDTO {
  const hub = fixtureHub();
  const die = hub.inventory.dice[0]!;
  return {
    windowDays: 7,
    windowStart: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
    entries: [
      {
        dieId: die.id,
        die,
        ownerName: 'Алиса',
        lastVictoryAt: NOW.toISOString(),
        lastVictoryPowerScore: die.powerScore,
        qualified: true,
      },
    ],
  };
}
