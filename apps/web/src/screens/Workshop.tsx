import { useState } from 'react';
import { ArrowRight, ArrowUpRight, Hammer, LockKeyhole, ShieldCheck, Sparkles } from 'lucide-react';
import type { DieDTO, SphereType } from '@dicebound/shared-types';
import { useInventoryView } from '../lib/inventory-view';
import { BASE_NAMES, SPHERES } from '../lib/catalog';
import { InventoryFeedback } from '../components/InventoryFeedback';
import { CraftResult } from '../components/CraftResult';
import { DieDetail } from '../components/DieDetail';
import { Orb } from '../components/Orb';
import { Modal } from '../components/Modal';
export function Workshop({
  initialDieId,
  onInventory,
}: {
  initialDieId: string | null;
  onInventory: () => void;
}) {
  const state = useInventoryView();
  const { hub } = state.inventory;
  const [showDetails, setShowDetails] = useState(() => window.innerWidth > 850);
  const [selectedId, setSelectedId] = useState(initialDieId ?? hub.player.equippedDieId);
  const [confirm, setConfirm] = useState<{
    die: DieDTO;
    sphere: SphereType;
    revision: number;
    amount: number;
    destructive: boolean;
  } | null>(null);
  const selected = hub.inventory.dice.find((d) => d.id === selectedId) ?? hub.inventory.dice[0];
  const policy = state.inventory.policies.find((p) => p.dieId === selected?.id);
  const revision = hub.player.inventoryRevision;
  return (
    <div className="workshop-page">
      <InventoryFeedback />
      <div className="workshop-intro">
        <div className="workshop-intro-mark">
          <Hammer size={27} strokeWidth={1.4} />
        </div>
        <div>
          <span className="eyebrow">АЛХИМИЯ ОДНОГО КУБИКА</span>
          <h2>Не новый артефакт. Новые возможности.</h2>
          <p>Выберите кубик и сферу. Перед изменением вы увидите цену и то, что будет потеряно.</p>
        </div>
        <span className="workshop-dust">
          <Sparkles size={17} />
          {hub.player.facetDust}
          <small>пыли граней</small>
        </span>
      </div>
      {state.result && <CraftResult result={state.result} onClose={state.clearResult} />}
      <div className="workshop-layout">
        <aside className="panel workpiece">
          <div className="section-heading">
            <div>
              <span className="eyebrow">01 · ВАШ АРТЕФАКТ</span>
              <h2>На верстаке</h2>
            </div>
            <button className="text-button" onClick={onInventory}>
              В сумку <ArrowUpRight size={14} />
            </button>
          </div>
          <label className="workpiece-select">
            Кубик для крафта
            <select
              value={selected?.id ?? ''}
              onChange={(e) => setSelectedId(e.target.value)}
              disabled={state.busy}
            >
              {hub.inventory.dice.map((die) => (
                <option key={die.id} value={die.id}>
                  {BASE_NAMES[die.baseType]} · {die.powerScore} PS
                  {die.isEquipped ? ' · в руке' : ''}
                  {die.isLocked ? ' · защищён' : ''}
                </option>
              ))}
            </select>
          </label>
          {selected && (
            <details
              className="workpiece-details"
              open={showDetails}
              onToggle={(event) => setShowDetails(event.currentTarget.open)}
            >
              <summary>
                Грани и свойства{' '}
                <span>
                  {selected.powerScore} PS · {selected.quality}% качества
                </span>
              </summary>
              <DieDetail key={selected.id} die={selected} />
            </details>
          )}{' '}
          {selected?.isLocked && (
            <div className="workshop-locked">
              <LockKeyhole size={18} />
              <p>Кубик защищён. Снимите защиту в инвентаре, прежде чем менять свойства.</p>
            </div>
          )}
        </aside>
        <section className="recipe-column">
          <div className="section-heading">
            <div>
              <span className="eyebrow">02 · ВЫБЕРИТЕ СФЕРУ</span>
              <h2>Шесть путей алхимии</h2>
            </div>
            <span className="count-tag">1 сфера за действие</span>
          </div>
          <div className="recipe-grid">
            {policy?.craft.map((option) => {
              const sphere = SPHERES[option.sphere];
              const amount =
                hub.inventory.spheres.find((s) => s.type === option.sphere)?.amount ?? 0;
              return (
                <button
                  className={`recipe-card ${option.allowed && !state.demo ? 'available' : ''}`}
                  key={option.sphere}
                  disabled={state.locked || !option.allowed || !selected}
                  onClick={() =>
                    setConfirm({
                      die: structuredClone(selected!),
                      sphere: option.sphere,
                      revision,
                      amount,
                      destructive: option.destructive,
                    })
                  }
                  aria-label={`Применить: ${sphere.name}`}
                >
                  <div className="recipe-top">
                    <Orb type={option.sphere} />
                    <span className={`recipe-count ${amount === 0 ? 'empty' : ''}`}>×{amount}</span>
                  </div>
                  <span className="eyebrow">СФЕРА</span>
                  <h3>{sphere.short}</h3>
                  <p>{sphere.description}</p>
                  <div className="recipe-footer">
                    {option.allowed && !state.demo ? (
                      <>
                        <span>{option.destructive ? 'Перезапись свойств' : 'Изменить кубик'}</span>
                        <ArrowUpRight size={16} />
                      </>
                    ) : (
                      <span>{state.demo ? 'Только просмотр' : option.reason}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
          <div className="workshop-footnote">
            <ShieldCheck size={17} />
            <div>
              <strong>Результат определяет сервер</strong>
              <p>
                Случайный крафт может ухудшить PS или повторить прежний результат. Перезагрузка и
                повтор запроса не дают ещё одну попытку. Пыль пока сохраняется для будущей точечной
                огранки.
              </p>
            </div>
          </div>
        </section>
      </div>
      {confirm && (
        <Modal
          eyebrow="ОПЕРАЦИЯ С ПРЕДМЕТОМ"
          title="Подтвердить крафт"
          onClose={() => setConfirm(null)}
        >
          <div className="prose">
            <div className="craft-consent-item">
              <Orb type={confirm.sphere} />
              <div>
                <span className="eyebrow">
                  {BASE_NAMES[confirm.die.baseType]} · {confirm.die.powerScore} PS
                </span>
                <h3>{SPHERES[confirm.sphere].name}</h3>
              </div>
            </div>
            <p>{SPHERES[confirm.sphere].description}</p>
            <div className="notice">
              <Sparkles size={19} />
              <span>
                Цена: <strong>1 сфера</strong>. В кошельке: {confirm.amount} → {confirm.amount - 1}.
                Золото не расходуется.
              </span>
            </div>
            <p className={confirm.destructive ? 'craft-warning' : 'muted'}>
              {confirm.destructive
                ? 'Текущая грань или свойства будут перезаписаны. Отмена после выполнения невозможна; PS может уменьшиться.'
                : confirm.sphere === 'TEMPERING'
                  ? 'Качество вырастет на 5%, до 20%. После округления целые значения граней могут не измениться сразу.'
                  : 'Грани и качество сохранятся. Набор новых аффиксов определит сервер.'}
            </p>
            <p className="small-text muted">
              {state.inventory.activeRunDieId ? 'Снимок текущего похода не изменится. ' : ''}
              Случайный результат не показывается заранее и может совпасть с прежним.
            </p>
            {revision !== confirm.revision && (
              <p role="alert">Инвентарь изменился. Закройте окно и проверьте цену заново.</p>
            )}
            <button
              className="button primary full"
              disabled={state.locked || revision !== confirm.revision}
              onClick={() => {
                const captured = confirm;
                setConfirm(null);
                void state.submit('/api/workshop/craft', {
                  dieId: captured.die.id,
                  expectedRevision: captured.revision,
                  sphere: captured.sphere,
                  confirmed: true,
                });
              }}
            >
              Подтвердить и потратить 1 сферу <ArrowRight size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
