import { useEffect, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Backpack,
  BookOpen,
  Check,
  ChevronDown,
  CircleHelp,
  Coins,
  Compass,
  Crown,
  Dices,
  Flame,
  FlaskConical,
  Hammer,
  Hexagon,
  LoaderCircle,
  Map,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Sun,
  Users,
} from 'lucide-react';
import type { DieDTO, SphereType } from '@dicebound/shared-types';
import { useSession } from './stores/session';
import { Hub } from './screens/Hub';
import { Inventory } from './screens/Inventory';
import { Expeditions } from './screens/Expeditions';
import { Workshop } from './screens/Workshop';
import { Wallet } from './screens/Wallet';
import { Modal } from './components/Modal';
import { DieDetail } from './components/DieDetail';
import { DieSculpture } from './components/Die';
import { Orb } from './components/Orb';
import { SPHERES } from './lib/catalog';

type Page = 'hub' | 'inventory' | 'wallet' | 'expeditions' | 'workshop';
type ModalKind =
  | 'entry'
  | 'rules'
  | 'roadmap'
  | 'expeditions'
  | 'raid'
  | 'leaderboard'
  | 'die'
  | `sphere:${SphereType}`;
const TITLES: Record<Page, { title: string; subtitle: string; breadcrumb: string }> = {
  workshop: {
    title: 'Искусство шести граней',
    subtitle: 'Одна сфера может изменить всю историю.',
    breadcrumb: 'МАСТЕРСКАЯ',
  },
  expeditions: {
    title: 'За порогом Обители',
    subtitle: 'Один бросок. Четыре способа изменить судьбу.',
    breadcrumb: 'ТРЕНИРОВОЧНЫЕ КАТАКОМБЫ',
  },
  hub: { title: 'У костра', subtitle: 'Вдохните. Вы дома, искатель.', breadcrumb: 'ОБЗОР ОБИТЕЛИ' },
  inventory: {
    title: 'Сумка искателя',
    subtitle: 'Не количество вещей, а сила одного кубика.',
    breadcrumb: 'ИНВЕНТАРЬ',
  },
  wallet: {
    title: 'Сферы и возможности',
    subtitle: 'Маленькие сокровища с большим будущим.',
    breadcrumb: 'КОШЕЛЁК АЛХИМИИ',
  },
};
const MODAL_TITLES: Record<Exclude<ModalKind, `sphere:${SphereType}`>, string> = {
  entry: 'Ваша Обитель — в Telegram',
  rules: 'Не удача. Тактика.',
  roadmap: 'История только начинается',
  expeditions: 'За порогом Обители',
  raid: 'Одна команда. Одна легенда.',
  leaderboard: 'Зал славы Обители',
  die: 'Ближе к сути',
};

export function App() {
  const { status, mode, hub, error, refreshing, initialize, refresh, viewDemo } = useSession();
  const [page, setPage] = useState<Page>('hub');
  const [modal, setModal] = useState<ModalKind | null>(null);
  const [workshopDieId, setWorkshopDieId] = useState<string | null>(null);
  const [selectedDie, setSelectedDie] = useState<DieDTO | null>(null);
  useEffect(() => {
    void initialize();
  }, [initialize]);
  useEffect(() => {
    document.title = `Dicebound — ${TITLES[page].title}`;
  }, [page]);
  useEffect(() => {
    const back = window.Telegram?.WebApp?.BackButton;
    if (mode !== 'telegram' || !back) return;
    const handle = () => {
      const dialog = document.querySelector<HTMLDialogElement>('dialog.modal[open]');
      if (dialog) {
        dialog.dispatchEvent(new Event('cancel', { cancelable: true }));
        return;
      }
      if (modal) setModal(null);
      else setPage('hub');
    };
    if (modal || page !== 'hub') back.show();
    else back.hide();
    back.onClick(handle);
    return () => {
      back.offClick(handle);
      back.hide();
    };
  }, [page, modal, mode, status]);
  const navigate = (next: Page) => {
    setPage(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
  };
  const openWorkshop = (dieId?: string) => {
    setWorkshopDieId(dieId ?? null);
    navigate('workshop');
  };
  const inspect = (die: DieDTO) => {
    setSelectedDie(die);
    setModal('die');
  };

  if (status !== 'ready' || !hub)
    return (
      <main className="launch-screen">
        <div className="launch-brand">
          <Dices size={29} />
          <span>DICEBOUND</span>
        </div>
        <DieSculpture />
        <h1>{status === 'error' ? 'Костёр подождёт.' : 'Находим вашу Обитель…'}</h1>
        {status === 'loading' ? (
          <LoaderCircle className="spin" size={25} aria-label="Загрузка" />
        ) : (
          <>
            <p role="alert">{error}</p>
            <button className="button primary" onClick={() => void initialize()}>
              Попробовать снова <RefreshCw size={16} />
            </button>
            <button className="text-button" onClick={viewDemo}>
              Посмотреть интерфейс без входа <ArrowUpRight size={15} />
            </button>
          </>
        )}
      </main>
    );

  const navItems = [
    { key: 'hub', label: 'Обитель', icon: Flame, action: () => navigate('hub') },
    { key: 'inventory', label: 'Инвентарь', icon: Backpack, action: () => navigate('inventory') },
    { key: 'wallet', label: 'Сферы', icon: FlaskConical, action: () => navigate('wallet') },
    {
      key: 'expeditions',
      label: 'Походы',
      icon: Compass,
      action: () => navigate('expeditions'),
    },
    {
      key: 'workshop',
      label: 'Мастерская',
      icon: Hammer,
      action: () => openWorkshop(),
    },
    {
      key: 'raid',
      label: 'Рейд Обители',
      icon: Hexagon,
      action: () => setModal('raid'),
      soon: true,
    },
    {
      key: 'leaderboard',
      label: 'Зал славы',
      icon: Crown,
      action: () => setModal('leaderboard'),
      soon: true,
    },
  ];
  const sphere = modal?.startsWith('sphere:') ? (modal.slice(7) as SphereType) : null;
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            navigate('hub');
          }}
          aria-label="Dicebound — главная"
        >
          <span className="brand-mark">
            <Dices size={27} strokeWidth={1.4} />
          </span>
          <span>
            DICEBOUND<small>CHAT RAIDERS</small>
          </span>
        </a>
        <div className="sidebar-divider">
          <span /> ВАШ МАЛЕНЬКИЙ МИР <span />
        </div>
        <button className="room-switcher" onClick={() => setModal('entry')}>
          <span className="room-emblem">
            <Flame size={18} />
          </span>
          <span>
            <strong>{hub.room.title}</strong>
            <small>
              <span className="online-dot" />
              {hub.room.memberCount} участников
            </small>
          </span>
          <ChevronDown size={14} />
        </button>
        <span className="nav-label">ПУТЬ ИСКАТЕЛЯ</span>
        <nav aria-label="Главная навигация">
          {navItems.map(({ key, label, icon: Icon, action, soon }) => (
            <button
              key={key}
              className={`nav-button ${page === key ? 'active' : ''}`}
              onClick={action}
              aria-current={page === key ? 'page' : undefined}
            >
              <Icon size={19} strokeWidth={1.5} />
              <span>{label}</span>
              {soon ? (
                <span className="soon-dot" title="В следующем этапе" />
              ) : page === key ? (
                <span className="active-nav-mark" />
              ) : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="development-card">
            <span className="eyebrow">ПРОЛОГ · ПЕРВЫЙ СПУСК</span>
            <h3>Собираемся в путь.</h3>
            <p>
              Хорошие истории
              <br />
              не рождаются за один день.
            </p>
            <button className="text-button" onClick={() => setModal('roadmap')}>
              Что впереди <ArrowUpRight size={14} />
            </button>
          </div>
          <button className="guide-button" onClick={() => setModal('rules')}>
            <BookOpen size={17} /> Полевой справочник <ArrowUpRight size={13} />
          </button>
          <div className="sidebar-footer">
            <span className="online-dot" /> Этап 3 · Мастерская
          </div>
        </div>
      </aside>
      <div className="workspace">
        {mode === 'demo' && (
          <div className="demo-banner">
            <span>
              <span className="demo-label">ОБЗОР</span>Демонстрационные данные · прогресс не
              сохраняется
            </span>
            <button onClick={() => setModal('entry')}>
              Как войти <ArrowUpRight size={12} />
            </button>
          </div>
        )}
        <header className="topbar">
          <div className="breadcrumb">
            <Flame size={15} />
            <span>ОБИТЕЛЬ</span>
            <span className="slash">/</span>
            <strong>{TITLES[page].breadcrumb}</strong>
          </div>
          <div className="topbar-right">
            <div className="currency" title="Золото">
              <Coins size={17} />
              <span>{hub.player.gold}</span>
            </div>
            <button
              className="currency vigor"
              onClick={() => setModal('expeditions')}
              aria-label={`Бодрость ${hub.player.vigor.current} из ${hub.player.vigor.maximum}`}
            >
              <Sun size={18} />
              <span>
                {hub.player.vigor.current}
                <small> / {hub.player.vigor.maximum}</small>
              </span>
            </button>
            <span className="topbar-divider" />
            <button className="profile-button" onClick={() => setModal('entry')}>
              <span className="avatar">{hub.player.firstName.slice(0, 1).toUpperCase()}</span>
              <span>
                {hub.player.firstName}
                <small>Начинающий искатель</small>
              </span>
            </button>
          </div>
        </header>
        <main className="main-content" id="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">МЕЖДУ ПРИКЛЮЧЕНИЯМИ</span>
              <h1>
                {TITLES[page].title}
                <span className="heading-star">✦</span>
              </h1>
              <p>{TITLES[page].subtitle}</p>
            </div>
            <div className="page-actions">
              {mode === 'telegram' && (
                <button
                  className="icon-button"
                  onClick={() => void refresh()}
                  disabled={refreshing}
                  aria-label="Обновить хаб"
                >
                  <RefreshCw size={18} className={refreshing ? 'spin' : ''} />
                </button>
              )}
              <button className="help-button" onClick={() => setModal('rules')}>
                <CircleHelp size={17} />
                <span>Как играть</span>
              </button>
            </div>
          </div>
          {error && (
            <div className="error-banner" role="alert">
              {error}
              <button className="text-button" onClick={() => void initialize()}>
                Войти заново
              </button>
            </div>
          )}
          {page === 'hub' && (
            <Hub
              hub={hub}
              onInventory={() => navigate('inventory')}
              onWallet={() => navigate('wallet')}
              onRules={() => setModal('rules')}
              onRaid={() => setModal('raid')}
              onExpeditions={() => navigate('expeditions')}
              onDie={inspect}
              onSphere={(type) => setModal(`sphere:${type}`)}
            />
          )}
          {page === 'expeditions' && <Expeditions onEntry={() => setModal('entry')} />}
          {page === 'inventory' && <Inventory onWorkshop={openWorkshop} />}
          {page === 'workshop' && (
            <Workshop
              key={workshopDieId ?? 'equipped'}
              initialDieId={workshopDieId}
              onInventory={() => navigate('inventory')}
            />
          )}
          {page === 'wallet' && (
            <Wallet
              hub={hub}
              onSphere={(type) => setModal(`sphere:${type}`)}
              onWorkshop={() => openWorkshop()}
            />
          )}
          <footer className="page-footer">
            <span>
              DICEBOUND <span className="footer-diamond">◆</span> CHAT RAIDERS
            </span>
            <span>Маленький чат. Большое приключение.</span>
          </footer>
        </main>
      </div>
      <nav className="mobile-nav" aria-label="Мобильная навигация">
        {navItems.slice(0, 5).map(({ key, label, icon: Icon, action }) => (
          <button
            key={key}
            onClick={action}
            className={page === key ? 'active' : ''}
            aria-current={page === key ? 'page' : undefined}
          >
            <Icon size={20} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      {modal && (
        <Modal
          title={
            sphere
              ? SPHERES[sphere].name
              : MODAL_TITLES[modal as Exclude<ModalKind, `sphere:${SphereType}`>]
          }
          onClose={() => setModal(null)}
        >
          {sphere ? (
            <div className="sphere-modal">
              <Orb type={sphere} />
              <span className="eyebrow">
                {SPHERES[sphere].rarity} · В КОШЕЛЬКЕ{' '}
                {hub.inventory.spheres.find((item) => item.type === sphere)?.amount ?? 0}
              </span>
              <p>{SPHERES[sphere].description}</p>
              <div className="notice">
                <Hammer size={18} />
                <span>
                  {mode === 'demo'
                    ? 'Сейчас ресурсы не расходуются. В обзоре доступен только просмотр Мастерской.'
                    : 'Применение сферы доступно в Мастерской после выбора кубика и подтверждения цены.'}
                </span>
              </div>
              <button
                className="button secondary full"
                onClick={() => {
                  setModal(null);
                  openWorkshop();
                }}
              >
                Открыть Мастерскую <ArrowRight size={15} />
              </button>
            </div>
          ) : modal === 'die' && selectedDie ? (
            <DieDetail die={selectedDie} />
          ) : modal === 'entry' ? (
            <div className="prose">
              <div className="notice">
                <ShieldCheck size={21} />
                <span>
                  {mode === 'demo'
                    ? 'Сейчас вы смотрите интерфейс на данных примера. Это не ваш игровой профиль.'
                    : `Вы вошли в Обитель «${hub.room.title}». Профиль и ресурсы хранятся на сервере.`}
                </span>
              </div>
              <p>
                В каждом дружеском чате — своя команда и отдельный герой. Для входа нужна ссылка
                именно вашего чата.
              </p>
              <ol>
                <li>Добавьте настроенного бота Dicebound в группу.</li>
                <li>Назначьте его администратором для проверки участников.</li>
                <li>
                  Отправьте <code>/game</code> и нажмите «Войти в Обитель».
                </li>
              </ol>
              <p className="muted small-text">
                Для владельца проекта: сначала настройте бота, Mini App и HTTPS-адрес по README.
                Публичный игровой бот ещё не развёрнут.
              </p>
            </div>
          ) : modal === 'rules' ? (
            <div className="prose">
              <span className="stage-label">ТРЕНИРОВКА · ЧЕТЫРЕ РЕШЕНИЯ</span>
              <p>
                Враг показывает намерение. Вы бросаете кубик — и решаете, как разыграть результат.
              </p>
              <div className="rules-list">
                <div>
                  <span>01</span>
                  <div>
                    <h3>Разыграть</h3>
                    <p>Используйте грань как есть и получите 1 концентрацию.</p>
                  </div>
                </div>
                <div>
                  <span>02</span>
                  <div>
                    <h3>Сменить стойку</h3>
                    <p>Превратите атаку в щит или щит в атаку с 50% эффективности.</p>
                  </div>
                </div>
                <div>
                  <span>03</span>
                  <div>
                    <h3>Перевернуть</h3>
                    <p>
                      Потратьте 1 концентрацию и сразу разыграйте противоположную грань: 1 ↔ 6, 2 ↔
                      5, 3 ↔ 4. Концентрация не возвращается.
                    </p>
                  </div>
                </div>
                <div>
                  <span>04</span>
                  <div>
                    <h3>Перебросить</h3>
                    <p>Один бесплатный переброс за бой. Меняет грань, но не завершает ход.</p>
                  </div>
                </div>
              </div>
              <div className="notice">
                <Dices size={20} />
                <span>
                  Бросок сохраняется на сервере. Закрыть и открыть приложение — не способ
                  перебросить грань. В браузерном обзоре бой доступен только для просмотра.
                </span>
              </div>
              <button
                className="button primary full"
                onClick={() => {
                  setModal(null);
                  navigate('inventory');
                }}
              >
                Изучить свой кубик <ArrowRight size={16} />
              </button>
            </div>
          ) : modal === 'roadmap' ? (
            <div className="prose">
              <p>
                Готовы Обитель, тренировочный поход и крафт сферами. Остальные системы добавляются
                поэтапно — без подмены игры случайными числами в браузере.
              </p>
              <div className="roadmap-list">
                {[
                  [
                    'Ваша Обитель',
                    'Вход через Telegram, отдельный профиль, стартовый комплект и хаб.',
                  ],
                  [
                    'Бросок и манёвр',
                    'Серверный бой и бесплатный тренировочный маршрут из семи уровней.',
                  ],
                  ['Маленькая алхимия', 'Шесть сфер, экипировка, защита и распыление кубиков.'],
                  ['Общая легенда', 'Асинхронные рейды, зал славы и редкие анонсы в чат.'],
                ].map(([title, text], index) => (
                  <div key={title}>
                    <span className={`roadmap-step ${index <= 2 ? 'complete' : ''}`}>
                      {index <= 2 ? <Check size={17} /> : `0${index + 1}`}
                    </span>
                    <div>
                      <h3>{title}</h3>
                      <p>{text}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : modal === 'expeditions' ? (
            <div className="prose">
              <div className="notice">
                <Sun size={22} />
                <span>
                  Бодрость: {hub.player.vigor.current} из {hub.player.vigor.maximum}. Восстановление
                  +3 каждый день UTC, максимум 6.
                </span>
              </div>
              <p>
                Тренировочные катакомбы не расходуют бодрость. Можно играть при любом её запасе;
                награды — небольшое количество золота и пыли.
              </p>
              <p>Обычные походы с усиленной добычей и выпадением снаряжения появятся позже.</p>
              <button
                className="button primary full"
                onClick={() => {
                  setModal(null);
                  navigate('expeditions');
                }}
              >
                К тренировкам <Map size={17} />
              </button>
            </div>
          ) : (
            <div className="prose">
              <span className="stage-label">ЭТАП 4 · В РАЗРАБОТКЕ</span>
              <div className="planned-emblem">{modal === 'raid' ? <Hexagon /> : <Crown />}</div>
              <p>
                {modal === 'raid'
                  ? 'Соберите 15 фрагментов печати всей Обителью и пробудите общего босса. Рейд продлится 48 часов — быть онлайн одновременно не нужно.'
                  : 'Здесь появятся лучшие кубики вашей Обители. В зачёт пойдут только артефакты, которые помогли выиграть бой за последние семь дней.'}
              </p>
              <div className="notice">
                {modal === 'raid' ? (
                  <>
                    <Users size={21} />
                    <span>
                      Личные фрагменты: {hub.player.sealFragments}. В алтаре:{' '}
                      {hub.room.sealFragments} из 15. Вклады и атаки ещё не доступны.
                    </span>
                  </>
                ) : (
                  <>
                    <Sparkles size={21} />
                    <span>
                      Уже доступны хаб, инвентарь, Мастерская и тренировочные бои. Этот раздел пока
                      не меняет игровой прогресс.
                    </span>
                  </>
                )}
              </div>
              <button className="button secondary full" onClick={() => setModal('roadmap')}>
                План приключения <ArrowUpRight size={15} />
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
