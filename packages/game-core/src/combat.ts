import { z } from 'zod';
import { ENEMY_TYPES } from '@dicebound/shared-types';
import type {
  BattleDecision,
  CombatDie,
  CombatState,
  EnemyType,
  FacePlay,
  PoisonEffect,
} from '@dicebound/shared-types';
import { combatStats, facePlay } from './catalog.js';
import { ENEMIES, enemyIntent, scaledEnemyValue } from './enemies.js';
import { oppositeFace } from './foundation.js';
import { requireRule } from './rules.js';

const count = z.number().int().nonnegative();
const poisonSchema = z.object({ damage: count, turns: count.max(3) });
export const effectsSchema = z.object({
  playerPoison: poisonSchema,
  enemyPoison: poisonSchema,
  weaknessTurns: count.max(1),
  enemyThorns: count,
});
export const intentSchema = z.object({
  kind: z.enum(['ATTACK', 'GUARD', 'WINDUP', 'POISON_ATTACK', 'SHIELD_BASH', 'CURSE']),
  label: z.string().max(200),
  value: count,
  baseValue: count,
  heal: count,
  poison: count,
  thorns: count,
  lifestealPercent: count.max(100),
});
export const combatLogSchema = z
  .array(z.object({ turn: count, message: z.string().max(300) }))
  .max(20);
const emptyPoison = (): PoisonEffect => ({ damage: 0, turns: 0 });
export function newCombat(
  type: EnemyType,
  die: CombatDie,
  hp: number,
  maxHp: number,
  enemyScale = 600,
): CombatState {
  if (!ENEMY_TYPES.includes(type) || hp < 1 || hp > maxHp) throw new Error('Invalid combat start');
  const stats = combatStats(die);
  const enemyHp = scaledEnemyValue(ENEMIES[type].hp, enemyScale);
  return {
    state: 'AWAITING_ROLL',
    currentRolledFace: null,
    focusCharges: stats.focus,
    rerollsLeft: stats.rerolls,
    turnNumber: 1,
    playerHp: hp,
    playerMaxHp: maxHp,
    playerShield: 0,
    enemyType: type,
    enemyScale,
    enemyHp,
    enemyMaxHp: enemyHp,
    enemyShield: 0,
    currentIntent: enemyIntent(type, 1, enemyHp, enemyHp, 0, enemyScale),
    effects: {
      playerPoison: emptyPoison(),
      enemyPoison: emptyPoison(),
      weaknessTurns: 0,
      enemyThorns: 0,
    },
    outcome: null,
    log: [],
  };
}
export function rollCombat(state: CombatState, face: number): CombatState {
  requireRule(
    state.state === 'AWAITING_ROLL',
    'ROLL_NOT_ALLOWED',
    'Бросок уже зафиксирован. Выберите действие.',
  );
  oppositeFace(face); // Validate a server-provided d6 result.
  return { ...structuredClone(state), state: 'AWAITING_DECISION', currentRolledFace: face };
}
export function combatOptions(state: CombatState, die: CombatDie) {
  if (state.state !== 'AWAITING_DECISION' || state.currentRolledFace === null) return null;
  const direct = facePlay(die, state.currentRolledFace);
  const shift: FacePlay | null =
    direct.action === 'HEAL'
      ? null
      : {
          ...direct,
          action: direct.action === 'GUARD' ? 'STRIKE' : 'GUARD',
          value: Math.ceil((direct.value * combatStats(die).stance) / 100),
        };
  const weaken = (play: FacePlay): FacePlay => ({
    ...play,
    value:
      state.effects.weaknessTurns > 0 && ['STRIKE', 'PIERCE'].includes(play.action)
        ? Math.floor(play.value * 0.7)
        : play.value,
  });
  return {
    direct: weaken(direct),
    shift: shift ? weaken(shift) : null,
    flip: weaken(facePlay(die, oppositeFace(state.currentRolledFace))),
  };
}
function log(state: CombatState, message: string) {
  state.log = [...state.log, { turn: state.turnNumber, message }].slice(-20);
}
function finishIfNeeded(state: CombatState): boolean {
  if (state.playerHp > 0 && state.enemyHp > 0) return false;
  state.state = 'FINISHED';
  state.currentRolledFace = null;
  state.outcome = state.playerHp <= 0 ? 'DEFEAT' : 'VICTORY';
  log(state, state.outcome === 'VICTORY' ? 'Противник повержен.' : 'Герой эвакуирован в Обитель.');
  return true;
}
/** Shield bypass ignores a portion of shield capacity, not a portion of damage. */
export function hit(hp: number, shield: number, damage: number, ignore = 0) {
  const absorbed = Math.min(damage, Math.max(0, shield - ignore));
  const hpDamage = Math.min(hp, damage - absorbed);
  return { hp: hp - hpDamage, shield: shield - absorbed, hpDamage };
}
function tick(effect: PoisonEffect) {
  if (effect.turns === 0) return 0;
  const damage = effect.damage;
  effect.turns--;
  if (effect.turns === 0) effect.damage = 0;
  return damage;
}
function addPoison(effect: PoisonEffect, damage: number) {
  if (damage > 0) {
    effect.damage += damage;
    effect.turns = 3;
  }
}

/** Reroll is the only non-committing decision. Flip commits and never awards focus. */
export function decideCombat(
  previous: CombatState,
  die: CombatDie,
  decision: BattleDecision,
  rerollFace?: number,
): CombatState {
  const options = combatOptions(previous, die);
  requireRule(options, 'DECISION_NOT_ALLOWED', 'Сначала бросьте кубик.');
  const state = structuredClone(previous);
  if (decision === 'REROLL') {
    requireRule(state.rerollsLeft > 0, 'NO_REROLLS', 'Перебросы закончились.');
    requireRule(rerollFace !== undefined, 'MISSING_SERVER_ROLL', 'Серверный бросок отсутствует.');
    oppositeFace(rerollFace);
    state.rerollsLeft--;
    state.currentRolledFace = rerollFace;
    log(state, `Переброс: грань ${rerollFace}.`);
    return state;
  }
  const stats = combatStats(die);
  let play: FacePlay;
  if (decision === 'FLIP') {
    requireRule(state.focusCharges > 0, 'NO_FOCUS', 'Недостаточно концентрации.');
    state.focusCharges--;
    play = options.flip;
  } else if (decision === 'SHIFT') {
    requireRule(options.shift, 'STANCE_UNAVAILABLE', 'Исцеление нельзя конвертировать в стойку.');
    play = options.shift;
  } else {
    requireRule(decision === 'DIRECT', 'INVALID_DECISION', 'Неизвестное действие.');
    state.focusCharges = Math.min(3, state.focusCharges + 1);
    play = options.direct;
  }
  const names = { STRIKE: 'атака', GUARD: 'щит', PIERCE: 'укол', HEAL: 'исцеление' };
  const modes = { DIRECT: 'разыграть', SHIFT: 'сменить стойку', FLIP: 'перевернуть' };
  log(state, `Грань ${play.face}: ${names[play.action]} ${play.value} — ${modes[decision]}.`);
  state.effects.weaknessTurns = 0;
  if (play.action === 'GUARD') state.playerShield += play.value;
  else if (play.action === 'HEAL')
    state.playerHp = Math.min(state.playerMaxHp, state.playerHp + play.value);
  else {
    const reflects =
      play.action === 'STRIKE' && state.enemyShield > 0 ? state.effects.enemyThorns : 0;
    const ignore = play.action === 'PIERCE' ? Math.ceil(state.enemyShield / 2) : stats.strikeIgnore;
    const result = hit(state.enemyHp, state.enemyShield, play.value, ignore);
    state.enemyHp = result.hp;
    state.enemyShield = result.shield;
    state.playerHp = Math.min(
      state.playerMaxHp,
      state.playerHp + Math.floor((result.hpDamage * stats.lifesteal) / 100),
    );
    if (play.action === 'PIERCE') addPoison(state.effects.enemyPoison, stats.poison);
    if (reflects > 0) {
      state.playerHp = Math.max(0, state.playerHp - reflects);
      log(state, `Шипы противника: ${reflects} урона.`);
    }
    log(state, `По здоровью противника: ${result.hpDamage}.`);
  }
  if (finishIfNeeded(state)) return state;
  const enemyPoison = tick(state.effects.enemyPoison);
  state.enemyHp = Math.max(0, state.enemyHp - enemyPoison);
  if (enemyPoison) log(state, `Яд противнику: ${enemyPoison}.`);
  if (finishIfNeeded(state)) return state;
  const playerPoison = tick(state.effects.playerPoison);
  state.playerHp = Math.max(0, state.playerHp - playerPoison);
  if (playerPoison) log(state, `Яд герою: ${playerPoison} (мимо щита).`);
  if (finishIfNeeded(state)) return state;

  const intent = state.currentIntent; // Never replace the announced intent mid-turn.
  const damage =
    intent.kind === 'SHIELD_BASH' ? intent.baseValue + state.enemyShield : intent.value;
  state.enemyShield = 0;
  state.effects.enemyThorns = 0;
  if (['ATTACK', 'POISON_ATTACK', 'SHIELD_BASH'].includes(intent.kind)) {
    const thornDamage = state.playerShield > 0 ? stats.thorns : 0;
    const result = hit(state.playerHp, state.playerShield, damage);
    state.playerHp = result.hp;
    state.playerShield = result.shield;
    state.enemyHp = Math.min(
      state.enemyMaxHp,
      state.enemyHp + Math.floor((result.hpDamage * intent.lifestealPercent) / 100),
    );
    state.enemyHp = Math.max(0, state.enemyHp - thornDamage);
    if (result.hpDamage > 0) addPoison(state.effects.playerPoison, intent.poison);
    log(state, `${intent.label}: ${damage} урона, по здоровью ${result.hpDamage}.`);
    if (thornDamage) log(state, `Ваши шипы: ${thornDamage}.`);
  } else if (intent.kind === 'GUARD') {
    state.enemyShield = intent.value;
    state.enemyHp = Math.min(state.enemyMaxHp, state.enemyHp + intent.heal);
    state.effects.enemyThorns = intent.thorns;
    log(state, `${intent.label}: щит ${intent.value}, лечение ${intent.heal}.`);
  } else if (intent.kind === 'CURSE') {
    state.effects.weaknessTurns = 1;
    log(state, intent.label);
  } else log(state, intent.label);
  if (finishIfNeeded(state)) return state;
  // The next player turn starts at this persisted boundary; rerolls do not reset shields.
  state.playerShield = Math.floor((state.playerShield * stats.retention) / 100);
  state.turnNumber++;
  state.state = 'AWAITING_ROLL';
  state.currentRolledFace = null;
  state.currentIntent = enemyIntent(
    state.enemyType,
    state.turnNumber,
    state.enemyHp,
    state.enemyMaxHp,
    state.enemyShield,
    state.enemyScale ?? 600,
  );
  return state;
}
