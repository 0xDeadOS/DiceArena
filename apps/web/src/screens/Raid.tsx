import { useEffect, useState } from 'react';
import {
  Crown,
  Flame,
  Hexagon,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  Shield,
  Skull,
  Sparkles,
  Swords,
  Trophy,
  Users,
  Zap,
} from 'lucide-react';
import type { FaceAction, RaidDTO } from '@dicebound/shared-types';
import { useSession } from '../stores/session';
import { useRaid } from '../stores/raid';
import { ACTIONS, BASE_NAMES } from '../lib/catalog';
import { FlatDie } from '../components/Die';

const actionName = (action: FaceAction): string => ACTIONS[action]?.name ?? action;

export function Raid({ onBack }: { onBack: () => void }) {
  const mode = useSession((state) => state.mode);
  const { raid, ready, busy, error, pending, load, submit, retry } = useRaid();
  const [tab, setTab] = useState<'raid' | 'hall'>('raid');

  useEffect(() => {
    void load();
  }, [load]);

  if (mode !== 'telegram')
    return (
      <div className="raid-demo">
        <Hexagon size={26} />
        <h2>Рейд Обители</h2>
        <p>
          Рейд доступен только внутри Telegram-чата: он общий для всей Обители и требует
          подтверждённого участия.
        </p>
        <button className="text-button" onClick={onBack}>
          Назад
        </button>
      </div>
    );

  return (
    <div className="raid-screen">
      <header className="raid-header">
        <button className="text-button" onClick={onBack} disabled={busy}>
          ← Обитель
        </button>
        <div className="raid-tabs">
          <button
            className={tab === 'raid' ? 'tab active' : 'tab'}
            onClick={() => setTab('raid')}
            disabled={busy}
          >
            <Swords size={14} /> Рейд
          </button>
          <button
            className={tab === 'hall' ? 'tab active' : 'tab'}
            onClick={() => setTab('hall')}
            disabled={busy}
          >
            <Trophy size={14} /> Зал славы
          </button>
        </div>
        <button className="text-button" onClick={() => void load()} disabled={busy}>
          <RefreshCw size={14} /> Обновить
        </button>
      </header>

      {error && (
        <div className="raid-warning">
          <span>{error}</span>
          {pending && (
            <button className="text-button" onClick={() => void retry()} disabled={busy}>
              Повторить
            </button>
          )}
        </div>
      )}

      {!ready && busy && (
        <div className="raid-loading">
          <LoaderCircle size={18} className="spin" /> Загружаем Обитель…
        </div>
      )}

      {ready && tab === 'raid' && raid && <RaidPanel raid={raid} busy={busy} submit={submit} />}
      {ready && tab === 'hall' && <HallOfFame busy={busy} />}
    </div>
  );
}

function RaidPanel({
  raid,
  busy,
  submit,
}: {
  raid: RaidDTO;
  busy: boolean;
  submit: (
    path: '/api/raid/contribute' | '/api/raid/summon' | '/api/raid/attack' | '/api/raid/decide',
    body: Record<string, unknown>,
  ) => Promise<void>;
}) {
  const [confirmSummon, setConfirmSummon] = useState(false);
  const active = raid.raid;
  return (
    <div className="raid-body">
      <section className="panel altar-panel">
        <h2>
          <Hexagon size={16} /> Алтарь печати
        </h2>
        <div className="altar-meter">
          {Array.from({ length: raid.altar.target }, (_, index) => (
            <span key={index} className={index < raid.altar.fragments ? 'shard lit' : 'shard'} />
          ))}
        </div>
        <p className="panel-hint">
          В алтаре {raid.altar.fragments} из {raid.altar.target}. Личные фрагменты:{' '}
          <strong>{raid.myFragments}</strong>.
        </p>
        <p className="panel-hint muted">
          Фрагменты печати даёт победа над боссом обычной экспедиции.
        </p>
        <div className="panel-actions">
          <button
            className="primary-button"
            disabled={busy || !raid.canContribute.allowed || raid.myFragments === 0}
            onClick={() =>
              void submit('/api/raid/contribute', {
                fragments: Math.min(raid.myFragments, raid.altar.target - raid.altar.fragments),
                expectedRevision: 0,
                confirmed: true,
              })
            }
          >
            <Sparkles size={15} /> Внести в алтарь
          </button>
          {raid.altar.ready && !active && (
            <button
              className="primary-button danger"
              disabled={busy || !raid.canSummon.allowed}
              onClick={() => {
                if (!confirmSummon) {
                  setConfirmSummon(true);
                  return;
                }
                void submit('/api/raid/summon', { expectedRevision: 0, confirmed: true });
                setConfirmSummon(false);
              }}
            >
              <Flame size={15} />
              {confirmSummon ? 'Подтвердите призыв' : 'Призвать рейд'}
            </button>
          )}
        </div>
        {!raid.canContribute.allowed && raid.canContribute.reason && (
          <p className="panel-hint muted">{raid.canContribute.reason}</p>
        )}
      </section>

      {active && (
        <section className="panel boss-panel">
          <h2>
            <Skull size={16} /> {active.bossName}
          </h2>
          <p className="panel-hint">
            {active.status === 'ACTIVE'
              ? `Раунд ${active.phase} из ${active.rounds.length} · осталось ${formatLeft(active.expiresAt)}`
              : active.status === 'DEFEATED'
                ? 'Обитель сломила босса.'
                : 'Время вышло — печать уцелела.'}
          </p>
          <div className="round-ladder">
            {active.rounds.map((round) => (
              <span
                key={round.round}
                className={
                  round.cleared
                    ? 'round-node cleared'
                    : round.round === active.phase && active.status === 'ACTIVE'
                      ? 'round-node current'
                      : 'round-node'
                }
                title={`Раунд ${round.round}: щит ${round.shield}`}
              >
                <Shield size={12} />
                {round.round}
              </span>
            ))}
          </div>
          <div className="boss-hp">
            <div className="hp-bar">
              <span
                style={{
                  width: `${Math.round((active.currentHp / Math.max(1, active.roundHp)) * 100)}%`,
                }}
              />
            </div>
            <small>
              {active.currentHp} / {active.roundHp} HP раунда · щит {active.shield}
            </small>
          </div>
          <div className="boss-stats">
            <span>
              <Zap size={13} /> Рогов сегодня: <strong>{raid.hornsLeft}</strong>
            </span>
            <span>
              <Flame size={13} /> Ваш урон: <strong>{active.myDamage}</strong>
            </span>
            <span>
              <Users size={13} /> Всего урона: <strong>{active.totalDamage}</strong>
            </span>
          </div>

          {active.attack ? (
            <div className="strike-panel">
              <h3>
                Удар по раунду {active.attack.round} · выпало {active.attack.currentRolledFace}
              </h3>
              {active.attack.currentRolledFace !== null && (
                <FlatDie face={active.attack.currentRolledFace} />
              )}
              <div className="panel-actions">
                {active.attack.options?.direct && (
                  <button
                    className="primary-button"
                    disabled={busy}
                    onClick={() =>
                      void submit('/api/raid/decide', {
                        raidId: active.id,
                        attackId: active.attack!.id,
                        expectedRevision: active.revision,
                        action: 'DIRECT',
                      })
                    }
                  >
                    {actionName(active.attack.options.direct.action)} ·{' '}
                    {active.attack.options.direct.value}
                  </button>
                )}
                {active.attack.options?.shift && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void submit('/api/raid/decide', {
                        raidId: active.id,
                        attackId: active.attack!.id,
                        expectedRevision: active.revision,
                        action: 'SHIFT',
                      })
                    }
                  >
                    Стойка · {actionName(active.attack.options.shift.action)} ·{' '}
                    {active.attack.options.shift.value}
                  </button>
                )}
                {active.attack.rerollsLeft > 0 && (
                  <button
                    className="secondary-button"
                    disabled={busy}
                    onClick={() =>
                      void submit('/api/raid/decide', {
                        raidId: active.id,
                        attackId: active.attack!.id,
                        expectedRevision: active.revision,
                        action: 'REROLL',
                      })
                    }
                  >
                    <RefreshCw size={14} /> Переброс ({active.attack.rerollsLeft})
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="panel-actions">
              <button
                className="primary-button"
                disabled={busy || !raid.canAttack.allowed}
                onClick={() =>
                  void submit('/api/raid/attack', {
                    raidId: active.id,
                    expectedRevision: active.revision,
                  })
                }
              >
                <Swords size={15} /> Ударить рогом
              </button>
              {!raid.canAttack.allowed && raid.canAttack.reason && (
                <span className="panel-hint muted">
                  <LockKeyhole size={13} /> {raid.canAttack.reason}
                </span>
              )}
            </div>
          )}
        </section>
      )}

      {!active && (
        <section className="panel empty-panel">
          <Hexagon size={22} />
          <p>
            Рейд не призван. Соберите {raid.altar.target} фрагментов в алтаре — и Обитель сможет
            вызвать босса на 48 часов.
          </p>
        </section>
      )}

      {active && active.contributions.length > 0 && (
        <section className="panel contributions-panel">
          <h2>
            <Flame size={16} /> Вклад Обители
          </h2>
          <ol className="contribution-list">
            {active.contributions.map((entry, index) => (
              <li key={entry.memberId}>
                <span className="rank">{index + 1}</span>
                <span className="name">{entry.firstName}</span>
                <span className="damage">{entry.damage} урона</span>
                <span className="attacks">{entry.attacks} уд.</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}

function HallOfFame({ busy }: { busy: boolean }) {
  const { leaderboard, loadLeaderboard } = useRaid();
  useEffect(() => {
    void loadLeaderboard();
  }, [loadLeaderboard]);
  if (!leaderboard)
    return (
      <div className="raid-loading">
        <LoaderCircle size={18} className="spin" /> Загружаем зал славы…
      </div>
    );
  return (
    <section className="panel hall-panel">
      <h2>
        <Crown size={16} /> Зал славы Обители
      </h2>
      <p className="panel-hint">
        Зачётное окно — {leaderboard.windowDays} дней. Учитываются кубики, которыми выигрывали бой
        за это время.
      </p>
      {leaderboard.entries.length === 0 ? (
        <p className="panel-hint muted">
          Пока никто не отметился. Выиграйте бой обычным кубиком — и он попадёт в зал славы.
        </p>
      ) : (
        <ol className="hall-list">
          {leaderboard.entries.map((entry, index) => (
            <li key={entry.dieId} className={busy ? 'dim' : undefined}>
              <span className="rank">{index + 1}</span>
              <span className="name">
                {BASE_NAMES[entry.die.baseType]} · ilvl {entry.die.ilvl}
              </span>
              <span className="owner">{entry.ownerName}</span>
              <span className="ps">{entry.lastVictoryPowerScore} PS</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function formatLeft(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return 'меньше часа';
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)} дн.`;
  return `${hours} ч.`;
}
