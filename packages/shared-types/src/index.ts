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
    facetDust: number;
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

export const ENEMY_TYPES = [
  'SLIME',
  'SPEARMAN',
  'PLAGUE_RAT',
  'STONE_GUARD',
  'BLOOD_PRIEST',
  'BONE_KING',
] as const;
export type EnemyType = (typeof ENEMY_TYPES)[number];
export type BattleDecision = 'DIRECT' | 'SHIFT' | 'FLIP' | 'REROLL';
export type CombatDie = Pick<
  DieDTO,
  'id' | 'baseType' | 'ilvl' | 'quality' | 'rarity' | 'faces' | 'affixes' | 'powerScore'
>;
export type CombatOutcome = 'VICTORY' | 'DEFEAT';
export interface EnemyIntent {
  kind: 'ATTACK' | 'GUARD' | 'WINDUP' | 'POISON_ATTACK' | 'SHIELD_BASH' | 'CURSE';
  label: string;
  value: number;
  baseValue: number;
  heal: number;
  poison: number;
  thorns: number;
  lifestealPercent: number;
}
export interface PoisonEffect {
  damage: number;
  turns: number;
}
export interface CombatEffects {
  playerPoison: PoisonEffect;
  enemyPoison: PoisonEffect;
  weaknessTurns: number;
  enemyThorns: number;
}
export interface CombatLogEntry {
  turn: number;
  message: string;
}
export interface CombatState {
  state: 'AWAITING_ROLL' | 'AWAITING_DECISION' | 'FINISHED';
  currentRolledFace: number | null;
  focusCharges: number;
  rerollsLeft: number;
  turnNumber: number;
  playerHp: number;
  playerMaxHp: number;
  playerShield: number;
  enemyType: EnemyType;
  enemyHp: number;
  enemyMaxHp: number;
  enemyShield: number;
  currentIntent: EnemyIntent;
  effects: CombatEffects;
  outcome: CombatOutcome | null;
  log: CombatLogEntry[];
}
export interface FacePlay {
  face: number;
  action: FaceAction;
  value: number;
}
export interface BattleDTO extends CombatState {
  id: string;
  enemyName: string;
  options: { direct: FacePlay; shift: FacePlay | null; flip: FacePlay } | null;
}
export type MapNodeType = 'START' | 'BATTLE' | 'ELITE' | 'CHEST' | 'CAMP' | 'BOSS';
export interface MapNodeDTO {
  id: string;
  depth: number;
  lane: number;
  type: MapNodeType;
  next: string[];
}
export interface TrainingLoot {
  gold: number;
  dust: number;
}
export interface RunDTO {
  id: string;
  revision: number;
  mode: 'TRAINING';
  status: 'IN_PROGRESS' | 'VICTORY' | 'DEFEAT';
  currentNodeId: string;
  visitedNodeIds: string[];
  nodes: MapNodeDTO[];
  availableNodeIds: string[];
  playerHp: number;
  playerMaxHp: number;
  loadout: CombatDie;
  loot: TrainingLoot;
  reward: TrainingLoot | null;
  battle: BattleDTO | null;
}
export interface RunResponse {
  run: RunDTO | null;
}
export interface RunMutation {
  runId: string;
  expectedRevision: number;
}
export interface MapStepRequest extends RunMutation {
  nodeId: string;
}
export interface BattleRollRequest extends RunMutation {
  battleId: string;
}
export interface BattleDecisionRequest extends BattleRollRequest {
  action: BattleDecision;
}
