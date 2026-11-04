/** Public contracts only. Never export database records or secret battle seeds here. */
export const SPHERE_TYPES = [
  'TEMPERING',
  'FACETING',
  'CASTING',
  'ASCENDANCE',
  'RESHAPING',
  'CLEANSING',
] as const;
export const FACE_ACTIONS = ['STRIKE', 'GUARD', 'PIERCE', 'HEAL'] as const;
export const DIE_BASES = ['BONE', 'IRON', 'OBSIDIAN'] as const;
export const RARITIES = ['NORMAL', 'MAGIC', 'RARE', 'UNIQUE'] as const;

export type SphereType = (typeof SPHERE_TYPES)[number];
export type FaceAction = (typeof FACE_ACTIONS)[number];
export type DieBase = (typeof DIE_BASES)[number];
export type Rarity = (typeof RARITIES)[number];

export interface DieFace {
  face: number;
  action: FaceAction;
  value: number;
}

export interface DieAffix {
  id: string;
  kind: 'PREFIX' | 'SUFFIX';
  tier: 1 | 2 | 3;
  value: number;
}

export interface DieDTO {
  id: string;
  baseType: DieBase;
  ilvl: number;
  quality: number;
  rarity: Rarity;
  faces: DieFace[];
  affixes: DieAffix[];
  powerScore: number;
  isStarter: boolean;
  isLocked: boolean;
  isEquipped: boolean;
  masterCrafted: boolean;
}

export interface TelegramIdentity {
  id: number;
  firstName: string;
  username: string | null;
}

export interface RoomContext {
  id: string;
  slug: string;
  title: string;
  telegramChatId: bigint;
}

export interface HubDTO {
  room: {
    id: string;
    slug: string;
    title: string;
    memberCount: number;
    sealFragments: number;
  };
  player: {
    id: string;
    firstName: string;
    username: string | null;
    gold: number;
    sealFragments: number;
    equippedDieId: string | null;
    vigor: { current: number; maximum: number; nextRestoreAt: string };
    tutorialDone: boolean;
  };
  inventory: {
    capacity: number;
    dice: DieDTO[];
    spheres: { type: SphereType; amount: number }[];
  };
  activeRun: {
    id: string;
    currentNodeId: string;
    playerHp: number;
    playerMaxHp: number;
    hasVigorBoost: boolean;
  } | null;
  raid: {
    id: string;
    bossName: string;
    currentHp: number;
    maxHp: number;
    expiresAt: string;
  } | null;
}

export interface SessionDTO {
  hub: HubDTO;
  authExpiresAt: string;
}

export interface ApiErrorDTO {
  error: { code: string; message: string; requestId: string };
}
