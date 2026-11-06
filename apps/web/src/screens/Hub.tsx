import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronRight,
  Dices,
  Gem,
  Hexagon,
  Map,
  PackageOpen,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
} from 'lucide-react';
import type { DieDTO, HubDTO, SphereType } from '@dicebound/shared-types';
import { DieSculpture, FlatDie } from '../components/Die';
import { Orb } from '../components/Orb';
import { BASE_NAMES, SPHERES, RARITY_NAMES } from '../lib/catalog';

const TUTORIAL_ORDER = ['TRAINING', 'REWARD', 'CRAFT', 'COMPLETE'] as const;
const TUTORIAL_HINTS: Record<string, string> = {
  TRAINING: 'Победите в тренировочных катакомбах — бой настоящий.',
  REWARD: 'Заберите учебную сферу Отливки за первую победу.',
  CRAFT: 'Примените любую сферу в Мастерской.',
  COMPLETE: 'Завершите обучение, чтобы открыть обычные экспедиции.',
};
interface Props {
  hub: HubDTO;
  onInventory: () => void;
  onWallet: () => void;
  onRules: () => void;
  onRaid: () => void;
  onExpeditions: () => void;
  onDie: (die: DieDTO) => void;
  onSphere: (type: SphereType) => void;
}
export function Hub({
  hub,
  onInventory,
  onWallet,
  onRules,
  onRaid,
  onExpeditions,
  onDie,
  onSphere,
}: Props) {
  const die = hub.inventory.dice.find((item) => item.isEquipped);
  return (
    <div className="dashboard-grid">
      <div className="main-column">
        <section className="hero-card">
          <div className="hero-arch" aria-hidden="true" />
          <div className="hero-arch inner" aria-hidden="true" />
          <div className="hero-content">
            <span className="eyebrow">
              <span className="tiny-diamond" /> ВАША ИСТОРИЯ НАЧИНАЕТСЯ
            </span>
            <h2>
              Большая судьба.
              <br />
              <em>Всего шесть граней.</em>
            </h2>
            <p>
              Один кубик. Бесчисленные возможности.
              <br />И друзья, с которыми не страшно
              <br className="desktop-break" /> спуститься во тьму.
            </p>
            <button className="button primary" onClick={onInventory}>
              Осмотреть снаряжение <ArrowRight size={16} />
            </button>
          </div>
          <DieSculpture className="hero-die" />
          <span className="hero-caption">D6 · ПЕРВЫЙ АРТЕФАКТ</span>
        </section>
        <div className="starter-strip">
          <span className="check-emblem">
            <Check size={16} />
          </span>
          <div>
            <strong>Первый шаг уже сделан</strong>
            <span>Стартовый кубик и сферы ждут в вашей сумке.</span>
          </div>
          <button onClick={onInventory} aria-label="Открыть стартовый набор">
            <ChevronRight size={18} />
          </button>
        </div>
        <section className="resources-section">
          <div className="section-heading">
            <div>
              <h2>Маленькая алхимия</h2>
              <span>Всё великое начинается с простого</span>
            </div>
            <button className="text-button" onClick={onWallet}>
              Все сферы <ArrowUpRight size={15} />
            </button>
          </div>
          <div className="sphere-cards">
            {(['TEMPERING', 'CASTING', 'FACETING'] as const).map((type) => (
              <button className="sphere-card" key={type} onClick={() => onSphere(type)}>
                <Orb type={type} />
                <div>
                  <span className="muted">Сфера</span>
                  <strong>{SPHERES[type].short}</strong>
                </div>
                <span className="sphere-amount">
                  ×{hub.inventory.spheres.find((sphere) => sphere.type === type)?.amount ?? 0}
                </span>
              </button>
            ))}
          </div>
        </section>
        <section className="expedition-card">
          <span className="map-emblem">
            <Map size={25} strokeWidth={1.3} />
          </span>
          <div>
            <span className="eyebrow">ЗА ПОРОГОМ ОБИТЕЛИ</span>
            <h3>
              {hub.player.tutorial.step === 'DONE'
                ? `Экспедиции до уровня ${Math.min(50, hub.player.highestExpeditionLevel + 1)}`
                : 'Тренировочные катакомбы'}
            </h3>
            <p>
              {hub.player.tutorial.step === 'DONE'
                ? `Спуск стоит 1 бодрость. Сейчас ${hub.player.vigor.current} из ${hub.player.vigor.maximum}.`
                : 'Семь уровней. Без затрат бодрости.'}
            </p>
          </div>
          <button className="upcoming-button" onClick={onExpeditions}>
            {hub.activeRun ? 'Продолжить' : 'В путь'} <ArrowUpRight size={15} />
          </button>
        </section>
        {hub.player.tutorial.step !== 'DONE' && (
          <section className="tutorial-progress">
            <span className="check-emblem">
              <Sparkles size={16} />
            </span>
            <div>
              <strong>
                Обучение · шаг {TUTORIAL_ORDER.indexOf(hub.player.tutorial.step) + 1} из 4
              </strong>
              <span>{TUTORIAL_HINTS[hub.player.tutorial.step]}</span>
            </div>
            <button onClick={onExpeditions} aria-label="Открыть обучение">
              <ChevronRight size={18} />
            </button>
          </section>
        )}
        {hub.inventory.pendingDrops.length > 0 && (
          <section className="starter-strip pending-strip">
            <span className="check-emblem">
              <PackageOpen size={16} />
            </span>
            <div>
              <strong>Трофеи ждут: {hub.inventory.pendingDrops.length}</strong>
              <span>Возьмите в сумку или распылите — без подтверждения ничего не пропадёт.</span>
            </div>
            <button onClick={onInventory} aria-label="Открыть трофеи">
              <ChevronRight size={18} />
            </button>
          </section>
        )}
      </div>
      <aside className="aside-column">
        {die && (
          <section className="panel equipped-panel">
            <div className="panel-heading">
              <span className="section-label">ВАШ ВЕРНЫЙ СПУТНИК</span>
              <span className="equipped-tag">
                <span /> В руке
              </span>
            </div>
            <button
              className="equipped-die-view"
              onClick={() => onDie(die)}
              aria-label="Осмотреть активный кубик"
            >
              <DieSculpture />
              <span className="die-rarity">
                {RARITY_NAMES[die.rarity]} · УР. {die.ilvl}
              </span>
            </button>
            <div className="equipped-name">
              <h3>{BASE_NAMES[die.baseType]}</h3>
              <ShieldCheck size={15} />
            </div>
            <div className="die-summary">
              <div>
                <span>Сила кубика</span>
                <strong>
                  {die.powerScore}
                  <Sparkles size={14} />
                </strong>
              </div>
              <div>
                <span>Качество</span>
                <strong>
                  {die.quality}
                  <small>%</small>
                </strong>
              </div>
              <div>
                <span>Грани</span>
                <strong>
                  6<small>/ 6</small>
                </strong>
              </div>
            </div>
            <button className="button secondary full" onClick={() => onDie(die)}>
              Рассмотреть грани <ArrowRight size={15} />
            </button>
          </section>
        )}
        <section className="panel raid-panel">
          <div className="panel-heading">
            <span className="section-label">ВМЕСТЕ МЫ СИЛЬНЕЕ</span>
            <Users size={15} />
          </div>
          <div className="raid-heading">
            <span className="seal-emblem">
              <Hexagon size={44} strokeWidth={1} />
              <Gem size={19} />
            </span>
            <div>
              <h3>{hub.raid ? hub.raid.bossName : 'Печать пробуждения'}</h3>
              <p>{hub.raid ? 'Общий рейд Обители' : 'Общая цель вашей Обители'}</p>
            </div>
          </div>
          <div className="progress-caption">
            <span>{hub.raid ? 'Здоровье босса' : 'Фрагменты печати'}</span>
            <strong>
              {hub.raid
                ? `${hub.raid.currentHp} / ${hub.raid.maxHp}`
                : `${hub.room.sealFragments} / 15`}
            </strong>
          </div>
          <div
            className="progress-track"
            role="progressbar"
            aria-label="Печать пробуждения"
            aria-valuenow={hub.raid?.currentHp ?? hub.room.sealFragments}
            aria-valuemin={0}
            aria-valuemax={hub.raid?.maxHp ?? 15}
          >
            <span
              style={{
                width: `${Math.min(100, 100 * (hub.raid ? hub.raid.currentHp / hub.raid.maxHp : hub.room.sealFragments / 15))}%`,
              }}
            />
          </div>
          <p className="raid-description">
            У каждого свой путь.
            <br />У вашей команды — одна легенда.
          </p>
          <button className="text-button" onClick={onRaid}>
            О рейдах Обители <ArrowUpRight size={15} />
          </button>
        </section>
      </aside>
      <section className="tactics-card">
        <div className="tactics-intro">
          <span className="book-emblem">
            <Dices size={23} strokeWidth={1.4} />
          </span>
          <div>
            <span className="eyebrow">ПОЛЕВОЙ СОВЕТ № 01</span>
            <h3>У каждой грани есть другая сторона.</h3>
            <p>Запомните пары — они ещё спасут вам жизнь.</p>
          </div>
        </div>
        <div className="tactical-pairs" aria-label="Противоположные грани: 1 и 6, 2 и 5, 3 и 4">
          {[1, 2, 3].map((face) => (
            <div key={face}>
              <FlatDie face={face} small />
              <span>↔</span>
              <FlatDie face={7 - face} small />
            </div>
          ))}
        </div>
        <button className="round-button" onClick={onRules} aria-label="Узнать о тактике боя">
          <ArrowUpRight size={20} />
        </button>
      </section>
      <div className="hub-footnote">
        <Shield size={13} />
        <span>Прогресс принадлежит этой Обители. В другом чате — новая история.</span>
      </div>
    </div>
  );
}
