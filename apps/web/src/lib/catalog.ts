import {
  Sword,
  Shield,
  Heart,
  Zap,
  Flame,
  Gem,
  FlaskConical,
  Sparkles,
  RefreshCw,
  Droplets,
} from 'lucide-react';
import type { DieBase, FaceAction, Rarity, SphereType } from '@dicebound/shared-types';

export const BASE_NAMES: Record<DieBase, string> = {
  BONE: 'Костяной кубик',
  IRON: 'Железный кубик',
  OBSIDIAN: 'Обсидиановый кубик',
};
export const RARITY_NAMES: Record<Rarity, string> = {
  NORMAL: 'Обычный',
  MAGIC: 'Магический',
  RARE: 'Редкий',
  UNIQUE: 'Уникальный',
};
export const ACTIONS: Record<
  FaceAction,
  { name: string; icon: typeof Sword; className: string; description: string }
> = {
  STRIKE: {
    name: 'Атака',
    icon: Sword,
    className: 'strike',
    description: 'Прямой физический урон противнику.',
  },
  GUARD: {
    name: 'Щит',
    icon: Shield,
    className: 'guard',
    description: 'Защита на следующий ход противника.',
  },
  PIERCE: {
    name: 'Укол',
    icon: Zap,
    className: 'pierce',
    description: 'Урон, игнорирующий половину щита врага.',
  },
  HEAL: {
    name: 'Исцеление',
    icon: Heart,
    className: 'heal',
    description: 'Восстановление здоровья героя.',
  },
};
export const SPHERES: Record<
  SphereType,
  {
    name: string;
    short: string;
    icon: typeof Sword;
    color: string;
    description: string;
    rarity: string;
  }
> = {
  TEMPERING: {
    name: 'Сфера Закалки',
    short: 'Закалка',
    icon: Flame,
    color: '#cf9c52',
    rarity: 'Обычная',
    description:
      'Добавляет 5% качества ко всем шести граням. Максимальное качество — 20%. Результат всегда предсказуем.',
  },
  FACETING: {
    name: 'Сфера Гранения',
    short: 'Гранение',
    icon: Gem,
    color: '#8fb0c9',
    rarity: 'Обычная',
    description:
      'Меняет действие и базовое значение одной случайной грани. Новое значение зависит от уровня предмета.',
  },
  CASTING: {
    name: 'Сфера Отливки',
    short: 'Отливка',
    icon: FlaskConical,
    color: '#a994cc',
    rarity: 'Обычная',
    description:
      'Превращает обычный кубик в магический с 1–2 аффиксами. На магическом кубике перебрасывает его свойства.',
  },
  ASCENDANCE: {
    name: 'Сфера Возвышения',
    short: 'Возвышение',
    icon: Sparkles,
    color: '#d9b868',
    rarity: 'Редкая',
    description:
      'Повышает магический кубик до редкого. Сохраняет старые аффиксы и добавляет новые, до 3–4 свойств.',
  },
  RESHAPING: {
    name: 'Сфера Перерождения',
    short: 'Перерождение',
    icon: RefreshCw,
    color: '#b87d78',
    rarity: 'Редкая',
    description:
      'Полностью заменяет 3–4 аффикса редкого кубика. Грани и качество сохраняются. Перед применением потребуется подтверждение.',
  },
  CLEANSING: {
    name: 'Сфера Очищения',
    short: 'Очищение',
    icon: Droplets,
    color: '#83b39e',
    rarity: 'Обычная',
    description:
      'Удаляет все аффиксы и делает кубик обычным. Грани и качество сохраняются. Перед применением потребуется подтверждение.',
  },
};
