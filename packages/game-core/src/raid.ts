import type { CombatDie, DieFace, FaceAction } from '@dicebound/shared-types';
import { DIE_BASES, FACE_ACTIONS } from '@dicebound/shared-types';
import { parseCombatDie } from './catalog.js';
import { hit } from './combat.js';
import { requireRule } from './rules.js';
import { evaluateDiePowerScore, facetingRange, rollAffixes } from './workshop.js';
import type { RandomInt } from './workshop.js';

/**
 * Асинхронный рейд Обители. Все числа ниже — явно выбранные временные параметры этого
 * инкремента: v2.0 задаёт структуру (48 часов, шесть раундов, три рога в сутки, зачёт семь
 * дней), но не задаёт баланс. Изменения требуют тестов и миграции сохранённых состояний.
 */
export const RAID_ROUNDS = 6;
export const RAID_DURATION_HOURS = 48;
export const DAILY_HORNS = 3;
export const SEAL_TARGET = 15;
export const RANKING_WINDOW_DAYS = 7;
export const HIGH_PS_ANNOUNCE_AT = 90;
export const ANNOUNCE_COOLDOWN_HOURS = 12;
/** Урон по раунду считается от эффективного значения грани с коэффициентами действия. */
export const RAID_ACTION_SHARE: Record<FaceAction, number> = {
  STRIKE: 100,
  PIERCE: 100,
  GUARD: 50,
  HEAL: 0,
};

export function sealProgress(fragments: number): { fragments: number; ready: boolean } {
  const safe = Math.max(0, Math.min(SEAL_TARGET, Math.floor(fragments) || 0));
  return { fragments: safe, ready: safe >= SEAL_TARGET };
}

/**
 * Запас здоровья одного раунда растёт с размером Обители: атаковать могут только участники.
 *
 * Коэффициент выведен из пропускной способности, а не выбран «на глаз». За 48 часов рейда
 * Обитель из N участников наносит 3 рога × 2 суток × N = 6N ударов. Суммарная прочность
 * босса — 6 × raidRoundHp(N) + Σ щитов (1+1+2+2+3+3 = 12) = 12N + 12, то есть на один
 * удар приходится (12N + 12) / 6N = 2 + 2/N: 4.0 для соло-Обители, 3.0 для четырёх
 * участников и 2.5 для восьми.
 *
 * Ориентир снизу — стартовый кубик. Его грани дают в среднем 3.67 «сырого» урона
 * (STRIKE 4, GUARD 5→2, STRIKE 6, PIERCE 5, HEAL 3→0, GUARD 7→3), но часть урона съедает
 * щит, а грань HEAL тратит рог впустую, поэтому реальный прогресс — около 2 за удар,
 * то есть 12 за шесть. Прочность соло-босса — 24, поэтому одним стартовым кубиком рейд
 * не добить: нужна огранка граней, стойка вместо HEAL либо второй участник. Это сделано
 * намеренно — рейд должен требовать развития снаряда, а не шести случайных бросков.
 */
export function raidRoundHp(memberCount: number): number {
  requireRule(
    Number.isInteger(memberCount) && memberCount >= 1 && memberCount <= 200,
    'INVALID_ROOM_SIZE',
    'Недопустимый размер Обители.',
  );
  return 2 * memberCount;
}

/**
 * Щит раунда пробивается только уколом; каждый следующий раунд защищён сильнее.
 * Растёт вдвое медленнее номера раунда: при шести раундах суммарный щит — 12, иначе
 * прочность босса превысила бы весь урон, который Обитель успевает нанести за 48 часов.
 */
export const raidShield = (round: number): number => {
  requireRound(round);
  return Math.ceil(round / 2);
};

export function raidMaxHp(memberCount: number): number {
  return raidRoundHp(memberCount) * RAID_ROUNDS;
}

function requireRound(round: number) {
  requireRule(
    Number.isInteger(round) && round >= 1 && round <= RAID_ROUNDS,
    'INVALID_RAID_ROUND',
    'Раунд рейда должен быть от 1 до 6.',
  );
}

/**
 * Один удар рога: разыгранная грань превращается в урон по текущему раунду.
 * Исцеление не наносит урона — как и в бою, его имеет смысл менять стойкой или переворотом.
 */
export function raidStrike(
  round: number,
  roundHp: number,
  shield: number,
  action: FaceAction,
  faceValue: number,
): { roundHp: number; shield: number; damage: number; roundCleared: boolean } {
  requireRound(round);
  requireRule(
    Number.isInteger(roundHp) && roundHp > 0,
    'INVALID_RAID_HP',
    'Раунд рейда уже завершён.',
  );
  requireRule(
    Number.isInteger(shield) && shield >= 0,
    'INVALID_RAID_SHIELD',
    'Недопустимый щит раунда.',
  );
  requireRule(
    FACE_ACTIONS.includes(action) && Number.isInteger(faceValue) && faceValue >= 0,
    'INVALID_RAID_STRIKE',
    'Недопустимый удар по рейду.',
  );
  const damage = Math.floor((faceValue * RAID_ACTION_SHARE[action]) / 100);
  // Укол игнорирует половину щита — то же правило, что и в обычном бою.
  const ignore = action === 'PIERCE' ? Math.ceil(shield / 2) : 0;
  const result = hit(roundHp, shield, damage, ignore);
  return {
    roundHp: result.hp,
    shield: result.shield,
    damage: result.hpDamage,
    roundCleared: result.hp === 0,
  };
}

/** Раунд, в котором окажется босс после урона: переход возможен сразу через несколько раундов. */
export function raidRoundAfter(round: number, cleared: boolean): number {
  requireRound(round);
  return cleared ? Math.min(RAID_ROUNDS, round + 1) : round;
}

export const hornsLeft = (attacksToday: number): number =>
  Math.max(0, DAILY_HORNS - Math.max(0, Math.floor(attacksToday) || 0));

export function raidExpiry(summonedAt: Date): Date {
  return new Date(summonedAt.getTime() + RAID_DURATION_HOURS * 3_600_000);
}

export const rankingWindowStart = (now: Date): Date =>
  new Date(now.getTime() - RANKING_WINDOW_DAYS * 86_400_000);

export const announceCooldownStart = (now: Date): Date =>
  new Date(now.getTime() - ANNOUNCE_COOLDOWN_HOURS * 3_600_000);

export interface RaidShare {
  memberId: string;
  damage: number;
}

/**
 * Награда делится по доле урона. Округление вниз, остаток добирает самый результативный
 * участник, поэтому сумма выплат всегда совпадает с пулом.
 */
export function raidReward(
  participants: readonly RaidShare[],
  pool: { gold: number; dust: number },
): { memberId: string; gold: number; dust: number }[] {
  const total = participants.reduce((sum, entry) => sum + Math.max(0, entry.damage), 0);
  const valid = participants.filter((entry) => entry.damage > 0);
  requireRule(
    valid.length > 0 && total > 0,
    'NO_RAID_PARTICIPANTS',
    'В рейде нет участников с уроном.',
  );
  const best = valid.reduce((top, entry) => (entry.damage > top.damage ? entry : top), valid[0]!);
  let goldLeft = pool.gold;
  let dustLeft = pool.dust;
  const result = valid.map((entry) => {
    const share = entry.damage / total;
    const gold = Math.floor(pool.gold * share);
    const dust = Math.floor(pool.dust * share);
    goldLeft -= gold;
    dustLeft -= dust;
    return { memberId: entry.memberId, gold, dust };
  });
  const top = result.find((entry) => entry.memberId === best.memberId)!;
  top.gold += goldLeft;
  top.dust += dustLeft;
  return result;
}

export const raidRewardPool = (memberCount: number) => ({
  gold: 40 + 25 * Math.max(1, memberCount),
  dust: 4 + 3 * Math.max(1, memberCount),
});

/**
 * Трофей рейда — единственный источник `UNIQUE` в игре. Он не выпадает случайно:
 * Обитель получает его за победу над боссом, а дальше решает, кто достоин.
 *
 * Свойства не придуманы заново: `UNIQUE` — это вершина редкости, поэтому набор
 * максимальный (2 префикса + 2 суффикса, предел схемы), а значения берутся из
 * опубликованного диапазона третьего тира. Игрок видит, что именно ему достанется,
 * до того как согласится, поэтому редкость не может быть ни сюрпризом, ни обманом.
 *
 * Уровень предмета растёт с уровнем Обители, но остаётся в пределах 1..50 — иначе
 * нарушился бы CHECK `Die_values_valid`.
 */
export const RAID_TROPHY_TIER = 3;
export function raidTrophyLevel(highestExpeditionLevel: number): number {
  requireRule(
    Number.isInteger(highestExpeditionLevel) &&
      highestExpeditionLevel >= 0 &&
      highestExpeditionLevel <= 50,
    'INVALID_TROPHY_LEVEL',
    'Недопустимый уровень Обители для трофея.',
  );
  // Уровень трофея опережает пройденный на два: рейд сложнее обычной экспедиции,
  // а третий тир аффиксов открывается только с 20-го уровня предмета.
  return Math.min(50, Math.max(20, highestExpeditionLevel + 2));
}
export function generateRaidTrophy(id: string, ilvl: number, random: RandomInt): CombatDie {
  const level = raidTrophyLevel(ilvl);
  const actions = [
    FACE_ACTIONS[0],
    FACE_ACTIONS[1],
    ...Array.from({ length: 4 }, () => FACE_ACTIONS[random(4)]!),
  ];
  for (let i = actions.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [actions[i], actions[j]] = [actions[j]!, actions[i]!];
  }
  const faces: DieFace[] = actions.map((action, index) => {
    const [min, max] = facetingRange(level, action);
    return { face: index + 1, action, value: min + random(max - min + 1) };
  });
  const die: CombatDie = {
    id,
    contentVersion: 0,
    baseType: DIE_BASES[random(DIE_BASES.length)]!,
    ilvl: level,
    quality: 0,
    rarity: 'UNIQUE',
    faces,
    affixes: rollAffixes(level, 4, [], random),
    powerScore: 0,
  };
  die.powerScore = evaluateDiePowerScore(die);
  return parseCombatDie(die);
}
