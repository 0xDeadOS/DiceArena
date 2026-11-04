import type { EnemyIntent, EnemyType } from '@dicebound/shared-types';

export const ENEMIES: Record<EnemyType, { name: string; hp: number }> = {
  SLIME: { name: 'Пещерный слизень', hp: 20 },
  SPEARMAN: { name: 'Гоблин-копейщик', hp: 24 },
  PLAGUE_RAT: { name: 'Чумная крыса', hp: 18 },
  STONE_GUARD: { name: 'Каменный страж', hp: 45 },
  BLOOD_PRIEST: { name: 'Кровавый жрец', hp: 40 },
  BONE_KING: { name: 'Король костей', hp: 75 },
};
// Level-zero training only. Normal difficulty/progression is deliberately not unlocked yet.
export const trainingValue = (value: number) => Math.max(1, Math.round(value * 0.6));
export function enemyIntent(
  type: EnemyType,
  turn: number,
  hp: number,
  maxHp: number,
  shield: number,
): EnemyIntent {
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
    intent('ATTACK', label, trainingValue(value), extra);
  const guard = (label: string, value: number, extra: Partial<EnemyIntent> = {}) =>
    intent('GUARD', label, trainingValue(value), extra);
  switch (type) {
    case 'SLIME':
      return turn % 2 === 1
        ? attack('Удар слизью', 5)
        : guard('Панцирь и восстановление', 4, { heal: trainingValue(3) });
    case 'SPEARMAN':
      return turn % 3 === 1
        ? attack('Укол копьём', 6)
        : turn % 3 === 2
          ? intent('WINDUP', 'Замах — следующий удар усилен')
          : attack('Тяжёлый удар', 12);
    case 'PLAGUE_RAT':
      return turn % 2 === 1
        ? attack('Ядовитый укус', 4, { kind: 'POISON_ATTACK', poison: trainingValue(2) })
        : attack('Укус', 6);
    case 'STONE_GUARD':
      return turn % 2 === 1
        ? guard('Каменный щит', 10)
        : intent(
            'SHIELD_BASH',
            'Толчок: базовый урон + оставшийся щит',
            trainingValue(8) + shield,
            { baseValue: trainingValue(8) },
          );
    case 'BLOOD_PRIEST':
      return turn % 2 === 1
        ? attack('Кровавый удар', 7, { lifestealPercent: 50 })
        : intent('CURSE', 'Слабость: −30% к атакующему действию на один ход', 30);
    case 'BONE_KING':
      return turn % 2 === 1
        ? attack(hp < maxHp / 2 ? 'Яростный удар' : 'Костяной удар', hp < maxHp / 2 ? 14 : 9)
        : guard('Щит с шипами', 8, { thorns: trainingValue(3) });
  }
}
