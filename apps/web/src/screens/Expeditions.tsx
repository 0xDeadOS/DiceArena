import { useEffect, useState } from 'react';
import {
  ArrowRight,
  Check,
  Coins,
  Compass,
  Crown,
  Dices,
  DoorOpen,
  Flame,
  Heart,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Shield,
  Skull,
  Sparkles,
  Sword,
  Tent,
  PackageOpen,
  Undo2,
  Zap,
} from 'lucide-react';
import type {
  BattleDTO,
  BattleDecision,
  FacePlay,
  MapNodeType,
  RunDTO,
} from '@dicebound/shared-types';
import { useSession } from '../stores/session';
import { useGame } from '../stores/game';
import { demoRun } from '../lib/demo-run';
import { ACTIONS, BASE_NAMES } from '../lib/catalog';
import { DieSculpture, FlatDie } from '../components/Die';
import { Modal } from '../components/Modal';

const NODES: Record<MapNodeType, { name: string; icon: typeof Sword }> = {
  START: { name: 'Обитель', icon: Flame },
  BATTLE: { name: 'Бой', icon: Sword },
  ELITE: { name: 'Элита', icon: Skull },
  CHEST: { name: 'Сундук', icon: PackageOpen },
  CAMP: { name: 'Привал', icon: Tent },
  BOSS: { name: 'Босс', icon: Crown },
};
const example = demoRun();
export function Expeditions({ onEntry }: { onEntry: () => void }) {
  const demo = useSession((s) => s.mode) === 'demo';
  const { run: current, ready, busy, error, pending, load, submit, retry } = useGame();
  const [confirmRetreat, setConfirmRetreat] = useState(false);
  useEffect(() => {
    if (!demo) void load();
  }, [demo, load]);
  const run = demo ? example : current;
  const locked = demo || busy || !!pending || !ready;
  const step = (nodeId: string) => {
    if (run)
      void submit('/api/map/step', { runId: run.id, expectedRevision: run.revision, nodeId });
  };
  const battleAction = (action?: BattleDecision) => {
    if (!run?.battle) return;
    void submit(action ? '/api/battle/decision' : '/api/battle/roll', {
      runId: run.id,
      battleId: run.battle.id,
      expectedRevision: run.revision,
      ...(action ? { action } : {}),
    });
  };
  return (
    <div className="expeditions-screen">
      {demo ? (
        <div className="training-notice">
          <LockKeyhole size={19} />
          <div>
            <strong>Пример боя · только просмотр</strong>
            <p>
              Броски и решения доступны после входа через Telegram. Здесь ничего не разыгрывается и
              не сохраняется.
            </p>
          </div>
          <button className="text-button" onClick={onEntry}>
            Как войти <ArrowRight size={15} />
          </button>
        </div>
      ) : (
        <div className="run-toolbar">
          <span>
            <Shield size={15} /> Броски сохранены на сервере
          </span>
          <button className="text-button" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={15} className={busy ? 'spin' : ''} />
            Обновить поход
          </button>
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {pending && (
        <div className="training-notice retry-notice" role="status">
          <RefreshCw size={18} />
          <div>
            <strong>Есть неподтверждённое действие</strong>
            <p>
              Повтор отправит тот же запрос с тем же ключом. Ресурсы не спишутся дважды. Другие
              действия пока заблокированы.
            </p>
          </div>
          <button className="button secondary" disabled={busy} onClick={() => void retry()}>
            Повторить запрос
          </button>
        </div>
      )}
      {!run && busy ? (
        <div className="training-intro">
          <LoaderCircle className="spin" />
          <p>Находим сохранённый маршрут…</p>
        </div>
      ) : !run ? (
        <section className="training-intro panel">
          <div className="training-crest">
            <Compass size={58} strokeWidth={1} />
          </div>
          <span className="eyebrow">ПЕРВЫЙ СПУСК · УРОВЕНЬ 0</span>
          <h2>Тренировочные катакомбы</h2>
          <p>
            Семь уровней до Короля костей. Выбирайте путь, читайте намерения врага и находите
            сильную сторону каждой грани.
          </p>
          <div className="training-perks">
            <span>
              <Zap size={16} />
              Без затрат бодрости
            </span>
            <span>
              <Coins size={16} />
              Золото и пыль
            </span>
            <span>
              <Shield size={16} />
              Кубик остаётся с вами
            </span>
          </div>
          <button
            className="button primary"
            disabled={locked}
            onClick={() => void submit('/api/map/start', {})}
          >
            Начать тренировку <ArrowRight size={17} />
          </button>
          <small>
            Победа: вся добыча. Поражение или отступление: 40%, с округлением вниз. Предметы и сферы
            здесь не выпадают.
          </small>
        </section>
      ) : (
        <>
          <div className="run-summary">
            <span>
              <Compass size={17} />
              Уровень {run.nodes.find((n) => n.id === run.currentNodeId)?.depth ?? 0} / 7
            </span>
            <span>
              <Heart size={17} />
              {run.playerHp} / {run.playerMaxHp} HP
            </span>
            <span title="Добыча будет начислена только после завершения похода">
              <Coins size={17} />
              {run.loot.gold} <small>золота</small>
            </span>
            <span>
              <Sparkles size={16} />
              {run.loot.dust} <small>пыли</small>
            </span>
          </div>
          <div className="expedition-layout">
            <aside className="route-column panel">
              <div className="route-heading">
                <div>
                  <span className="eyebrow">ОДИН КУБИК · ВАШ ПУТЬ</span>
                  <h2>Вниз, во тьму.</h2>
                </div>
                <Compass size={23} />
              </div>
              <RouteMap run={run} locked={locked} onStep={step} />
              <p className="route-note">
                {run.status !== 'IN_PROGRESS'
                  ? 'Этот маршрут завершён.'
                  : run.battle?.state !== 'FINISHED' && run.battle
                    ? 'Завершите бой, чтобы выбрать следующий узел.'
                    : 'Золотой контур — доступный следующий узел.'}
              </p>
              <div className="run-loadout">
                <Dices size={19} />
                <span>
                  {BASE_NAMES[run.loadout.baseType]}
                  <small>PS {run.loadout.powerScore} · снаряжение зафиксировано</small>
                </span>
              </div>
              {run.status === 'IN_PROGRESS' && !demo && (
                <button
                  className="text-button retreat-link"
                  disabled={locked}
                  onClick={() => setConfirmRetreat(true)}
                >
                  <DoorOpen size={16} />
                  Отступить в Обитель
                </button>
              )}
            </aside>
            <div className="battle-column">
              {run.status !== 'IN_PROGRESS' ? (
                <section className="run-result panel" aria-live="polite">
                  {run.status === 'VICTORY' ? <Crown size={45} /> : <Flame size={45} />}
                  <span className="eyebrow">ПОХОД ЗАВЕРШЁН</span>
                  <h2>{run.status === 'VICTORY' ? 'Катакомбы пройдены.' : 'Вы снова у костра.'}</h2>
                  <p>
                    {run.status === 'VICTORY'
                      ? 'Вся собранная добыча уже в вашем кошельке.'
                      : '40% добычи, с округлением вниз, уже зачислены. Кубик и сферы не потеряны.'}
                  </p>
                  <div className="settled-reward">
                    <span>
                      <Coins size={21} />+{run.reward?.gold ?? 0} золота
                    </span>
                    <span>
                      <Sparkles size={21} />+{run.reward?.dust ?? 0} пыли
                    </span>
                  </div>
                  <button
                    className="button primary"
                    disabled={locked}
                    onClick={() => void submit('/api/map/start', {})}
                  >
                    Новая тренировка <ArrowRight size={16} />
                  </button>
                </section>
              ) : run.battle?.state !== 'FINISHED' && run.battle ? (
                <Battle battle={run.battle} locked={locked} busy={busy} onAction={battleAction} />
              ) : (
                <section className="node-result panel">
                  <span className="training-crest">
                    {run.battle ? <Check size={42} /> : <Compass size={42} />}
                  </span>
                  <span className="eyebrow">ПУТЬ ПРОДОЛЖАЕТСЯ</span>
                  <h2>
                    {run.battle
                      ? 'Противник повержен.'
                      : run.nodes.find((n) => n.id === run.currentNodeId)?.type === 'CHEST'
                        ? 'Небольшое сокровище.'
                        : run.nodes.find((n) => n.id === run.currentNodeId)?.type === 'CAMP'
                          ? 'Передышка у огня.'
                          : 'Катакомбы ждут.'}
                  </h2>
                  <p>
                    {run.battle
                      ? 'Добыча добавлена в рюкзак. Выберите следующий узел.'
                      : run.nodes.find((n) => n.id === run.currentNodeId)?.type === 'CHEST'
                        ? 'В рюкзак добавлены 3 золота и 1 пыль.'
                        : run.nodes.find((n) => n.id === run.currentNodeId)?.type === 'CAMP'
                          ? 'Восстановлено до 35% максимального здоровья (округление вверх). Можно идти дальше.'
                          : 'Первый противник — пещерный слизень. Держите кубик крепче.'}
                  </p>
                  <div className="next-node-actions">
                    {run.nodes
                      .filter((n) => run.availableNodeIds.includes(n.id))
                      .map((node) => {
                        const Icon = NODES[node.type].icon;
                        return (
                          <button
                            key={node.id}
                            className="button secondary"
                            disabled={locked}
                            onClick={() => step(node.id)}
                          >
                            <Icon size={17} />
                            Дальше: {NODES[node.type].name}
                            <ArrowRight size={15} />
                          </button>
                        );
                      })}
                  </div>
                </section>
              )}
              <p className="training-footnote">
                <Shield size={14} />
                Тренировка не расходует бодрость. Закрытие приложения не меняет грань или намерение.
              </p>
            </div>
          </div>
        </>
      )}
      {confirmRetreat && run && (
        <Modal title="Вернуться к костру?" onClose={() => setConfirmRetreat(false)}>
          <div className="prose">
            <p>
              Поход завершится. Вы сохраните 40% накопленной добычи:{' '}
              {Math.floor(run.loot.gold * 0.4)} золота и {Math.floor(run.loot.dust * 0.4)} пыли.
              Кубик останется у вас.
            </p>
            <p className="small-text muted">
              Это предварительный расчёт. Итог проверит сервер по текущему состоянию похода.
            </p>
            <button
              className="button primary full"
              disabled={locked}
              onClick={() => {
                setConfirmRetreat(false);
                void submit('/api/map/retreat', { runId: run.id, expectedRevision: run.revision });
              }}
            >
              Подтвердить отступление <DoorOpen size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function RouteMap({
  run,
  locked,
  onStep,
}: {
  run: RunDTO;
  locked: boolean;
  onStep: (id: string) => void;
}) {
  const x = (id: string) => {
    const node = run.nodes.find((n) => n.id === id)!;
    return run.nodes.filter((n) => n.depth === node.depth).length === 1
      ? 120
      : node.lane === 0
        ? 60
        : 180;
  };
  return (
    <div className="route-map" aria-label="Карта тренировочного похода">
      <svg
        className="route-lines"
        viewBox="0 0 240 480"
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {run.nodes.flatMap((node) =>
          node.next.map((id) => (
            <path
              key={`${node.id}-${id}`}
              d={`M ${x(node.id)} ${node.depth * 60 + 30} L ${x(id)} ${(node.depth + 1) * 60 + 30}`}
              className={
                run.visitedNodeIds.includes(node.id) && run.visitedNodeIds.includes(id)
                  ? 'traveled'
                  : ''
              }
            />
          )),
        )}
      </svg>
      {Array.from({ length: 8 }, (_, depth) => (
        <div
          className={`route-row ${run.nodes.filter((n) => n.depth === depth).length === 1 ? 'single' : ''}`}
          key={depth}
        >
          {run.nodes
            .filter((n) => n.depth === depth)
            .map((node) => {
              const Icon = NODES[node.type].icon;
              const active = node.id === run.currentNodeId;
              const visited = run.visitedNodeIds.includes(node.id);
              const available = run.availableNodeIds.includes(node.id);
              return (
                <button
                  className={`map-node ${active ? 'current' : ''} ${available ? 'available' : ''} ${visited ? 'visited' : ''}`}
                  key={node.id}
                  onClick={() => onStep(node.id)}
                  disabled={locked || !available}
                  aria-current={active ? 'step' : undefined}
                  aria-label={`Уровень ${depth}: ${NODES[node.type].name}${active ? ' — вы здесь' : available ? ' — доступно' : ''}`}
                >
                  <Icon size={18} />
                  <span>{NODES[node.type].name}</span>
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}
function Hp({
  label,
  hp,
  max,
  enemy = false,
}: {
  label: string;
  hp: number;
  max: number;
  enemy?: boolean;
}) {
  return (
    <div className={`combat-hp ${enemy ? 'enemy' : ''}`}>
      <div>
        <span>{label}</span>
        <strong>
          {hp}
          <small> / {max}</small>
        </strong>
      </div>
      <div
        className="hp-track"
        role="progressbar"
        aria-label={`Здоровье: ${label}`}
        aria-valuenow={hp}
        aria-valuemin={0}
        aria-valuemax={max}
      >
        <span style={{ width: `${(100 * hp) / max}%` }} />
      </div>
    </div>
  );
}
function playLabel(play: FacePlay | null) {
  return play ? `${ACTIONS[play.action].name} ${play.value}` : 'Недоступно для исцеления';
}
function Battle({
  battle,
  locked,
  busy,
  onAction,
}: {
  battle: BattleDTO;
  locked: boolean;
  busy: boolean;
  onAction: (action?: BattleDecision) => void;
}) {
  const intent = battle.currentIntent;
  const options = battle.options;
  return (
    <section className="battle-panel panel" aria-label="Бой">
      <div className="battle-heading">
        <div>
          <span className="eyebrow">ТРЕНИРОВОЧНЫЙ БОЙ · ХОД {battle.turnNumber}</span>
          <h2>{battle.enemyName}</h2>
        </div>
        <span className="enemy-emblem">
          {battle.enemyType === 'BONE_KING' ? <Crown size={27} /> : <Skull size={27} />}
        </span>
      </div>
      <div className="combatants">
        <div>
          <Hp label="Искатель" hp={battle.playerHp} max={battle.playerMaxHp} />
          <div className="combat-effects">
            <span>
              <Shield size={13} />
              {battle.playerShield} щита
            </span>
            {battle.effects.playerPoison.turns > 0 && (
              <span className="poison">
                Яд {battle.effects.playerPoison.damage} × {battle.effects.playerPoison.turns}
              </span>
            )}
            {battle.effects.weaknessTurns > 0 && <span>Слабость −30%</span>}
          </div>
        </div>
        <div>
          <Hp label="Противник" hp={battle.enemyHp} max={battle.enemyMaxHp} enemy />
          <div className="combat-effects">
            <span>
              <Shield size={13} />
              {battle.enemyShield} щита
            </span>
            {battle.effects.enemyPoison.turns > 0 && (
              <span className="poison">
                Яд {battle.effects.enemyPoison.damage} × {battle.effects.enemyPoison.turns}
              </span>
            )}
            {battle.effects.enemyThorns > 0 && <span>Шипы {battle.effects.enemyThorns}</span>}
          </div>
        </div>
      </div>
      <div className="enemy-intent">
        <Sword size={20} />
        <div>
          <span>НАМЕРЕНИЕ ПРОТИВНИКА</span>
          <strong>{intent.label}</strong>
          <small>
            {intent.kind === 'SHIELD_BASH'
              ? `${intent.baseValue} + оставшийся щит (сейчас ${battle.enemyShield})`
              : intent.kind === 'GUARD'
                ? `${intent.value} щита${intent.heal ? ` · лечение ${intent.heal}` : ''}${intent.thorns ? ` · шипы ${intent.thorns}` : ''}`
                : ['ATTACK', 'POISON_ATTACK'].includes(intent.kind)
                  ? `${intent.value} урона${intent.poison ? ` · яд ${intent.poison}` : ''}${intent.lifestealPercent ? ` · вампиризм ${intent.lifestealPercent}%` : ''}`
                  : intent.kind === 'CURSE'
                    ? 'Ослабит атакующее действие следующего хода'
                    : 'В этот ход не атакует'}
          </small>
        </div>
      </div>
      <div className="battle-resources">
        <span>
          <Sparkles size={15} />
          Концентрация <strong>{battle.focusCharges} / 3</strong>
        </span>
        <span>
          <RefreshCw size={14} />
          Перебросы <strong>{battle.rerollsLeft}</strong>
        </span>
      </div>
      {battle.state === 'AWAITING_ROLL' ? (
        <div className="roll-platform">
          <DieSculpture />
          <p>Намерение известно. Время сделать бросок.</p>
          <button className="button primary" disabled={locked} onClick={() => onAction()}>
            {busy ? <LoaderCircle size={18} className="spin" /> : <Dices size={18} />}Бросить кубик
          </button>
          <small>Результат зафиксируется на сервере.</small>
        </div>
      ) : (
        options && (
          <div className="decision-platform">
            <div className="saved-face">
              <FlatDie face={battle.currentRolledFace!} />
              <div>
                <span className="eyebrow">БРОСОК ЗАФИКСИРОВАН</span>
                <h3 role="status">
                  Грань {battle.currentRolledFace} · {playLabel(options.direct)}
                </h3>
                <p>Выберите, как разыграть её.</p>
              </div>
            </div>
            <div className="combat-actions">
              <button
                className="combat-action direct"
                disabled={locked}
                onClick={() => onAction('DIRECT')}
              >
                <Sword size={18} />
                <strong>Разыграть</strong>
                <span>{playLabel(options.direct)}</span>
                <small>+1 концентрация, максимум 3</small>
              </button>
              <button
                className="combat-action"
                disabled={locked || !options.shift}
                onClick={() => onAction('SHIFT')}
              >
                <Shield size={18} />
                <strong>Сменить стойку</strong>
                <span>{playLabel(options.shift)}</span>
                <small>Без прироста концентрации</small>
              </button>
              <button
                className="combat-action"
                disabled={locked || battle.focusCharges < 1}
                onClick={() => onAction('FLIP')}
              >
                <Undo2 size={18} />
                <strong>Перевернуть</strong>
                <span>
                  Грань {options.flip.face} · {playLabel(options.flip)}
                </span>
                <small>
                  {battle.focusCharges < 1
                    ? 'Нужна 1 концентрация'
                    : '−1 концентрация · завершает ход'}
                </small>
              </button>
              <button
                className="combat-action"
                disabled={locked || battle.rerollsLeft < 1}
                onClick={() => onAction('REROLL')}
              >
                <RefreshCw size={18} />
                <strong>Перебросить</strong>
                <span>Осталось: {battle.rerollsLeft}</span>
                <small>Не завершает ход</small>
              </button>
            </div>
            <p className="decision-note">
              Любое действие, кроме переброса, завершает ход. Враг отвечает, только если выжил.
            </p>
          </div>
        )
      )}
      {battle.log.length > 0 && (
        <details className="combat-log">
          <summary>
            Хроника боя <span>последние {battle.log.length} событий</span>
          </summary>
          <ol>
            {battle.log.map((entry, i) => (
              <li key={i}>
                <small>ХОД {entry.turn}</small>
                {entry.message}
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
