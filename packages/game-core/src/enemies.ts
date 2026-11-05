import type { EnemyIntent, EnemyType } from '@dicebound/shared-types';

export const ENEMIES: Record<EnemyType, { name: string; hp: number }> = {
  SLIME: { name: 'Пещерный слизень', hp: 20 },
  SPEARMAN: { name: 'Гоблин-копейщик', hp: 24 },
  PLAGUE_RAT: { name: 'Чумная крыса', hp: 18 },
  STONE_GUARD: { name: 'Каменный страж', hp: 45 },
  BLOOD_PRIEST: { name: 'Кровавый жрец', hp: 40 },
  BONE_KING: { name: 'Король костей', hp: 75 },
};
/** Integer per-mille scaling is frozen on each run, never inferred from current gear. */
export function scaledEnemyValue(value: number, scale: number) {
  if (!Number.isInteger(scale) || scale < 100 || scale > 5000)
    throw new RangeError('Invalid enemy scale');
  return Math.max(1, Math.round((value * scale) / 1000));
}
export const trainingValue = (value: number) => scaledEnemyValue(value, 600);
export function enemyIntent(
  type: EnemyType,
  turn: number,
  hp: number,
  maxHp: number,
  shield: number,
  scale = 600,
): EnemyIntent {
  const scaled = (value: number) => scaledEnemyValue(value, scale);
  const intent = (
    kind: EnemyIntent['kind'],
    label: string,
    value = 0,
    extra: Partial<EnemyIntent> = {},
  ): EnemyIntent => ({
    kind,
    label,
    value,
    baseValue: 0,
    heal: 0,
    poison: 0,
    thorns: 0,
    lifestealPercent: 0,
    ...extra,
  });
  const attack = (label: string, value: number, extra: Partial<EnemyIntent> = {}) =>
    intent('ATTACK', label, scaled(value), extra);
  const guard = (label: string, value: number, extra: Partial<EnemyIntent> = {}) =>
    intent('GUARD', label, scaled(value), extra);
  switch (type) {
    case 'SLIME':
      return turn % 2 === 1
        ? attack('Удар слизью', 5)
        : guard('Панцирь и восстановление', 4, { heal: scaled(3) });
    case 'SPEARMAN':
      return turn % 3 === 1
        ? attack('Укол копьём', 6)
        : turn % 3 === 2
          ? intent('WINDUP', 'Замах — следующий удар усилен')
          : attack('Тяжёлый удар', 12);
    case 'PLAGUE_RAT':
      return turn % 2 === 1
        ? attack('Ядовитый укус', 4, { kind: 'POISON_ATTACK', poison: scaled(2) })
        : attack('Укус', 6);
    case 'STONE_GUARD':
      return turn % 2 === 1
        ? guard('Каменный щит', 10)
        : intent('SHIELD_BASH', 'Толчок: базовый урон + оставшийся щит', scaled(8) + shield, {
            baseValue: scaled(8),
          });
    case 'BLOOD_PRIEST':
      return turn % 2 === 1
        ? attack('Кровавый удар', 7, { lifestealPercent: 50 })
        : intent('CURSE', 'Слабость: −30% к атакующему действию на один ход', 30);
    case 'BONE_KING':
      return turn % 2 === 1
        ? attack(hp < maxHp / 2 ? 'Яростный удар' : 'Костяной удар', hp < maxHp / 2 ? 14 : 9)
        : guard('Щит с шипами', 8, { thorns: scaled(3) });
  }
}
