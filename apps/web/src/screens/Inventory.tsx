import { Check, Hammer, LockKeyhole, Plus, ShieldCheck, Trash2, UnlockKeyhole } from 'lucide-react';
import type { DieDTO } from '@dicebound/shared-types';
import { useState } from 'react';
import { FlatDie } from '../components/Die';
import { DieDetail } from '../components/DieDetail';
import { Modal } from '../components/Modal';
import { InventoryFeedback } from '../components/InventoryFeedback';
import { CraftResult } from '../components/CraftResult';
import { BASE_NAMES } from '../lib/catalog';
import { useInventoryView } from '../lib/inventory-view';
export function Inventory({ onWorkshop }: { onWorkshop: (dieId?: string) => void }) {
  const state = useInventoryView();
  const { hub } = state.inventory;
  const [selectedId, setSelectedId] = useState<string | null>(hub.player.equippedDieId);
  const [confirm, setConfirm] = useState<{ die: DieDTO; revision: number; dust: number } | null>(
    null,
  );
  const selected = hub.inventory.dice.find((d) => d.id === selectedId) ?? hub.inventory.dice[0];
  const policy = state.inventory.policies.find((p) => p.dieId === selected?.id);
  const revision = hub.player.inventoryRevision;
  return (
    <div className="inventory-page">
      <InventoryFeedback />
      {state.result && <CraftResult result={state.result} onClose={state.clearResult} />}
      <div className="inventory-layout">
        <section>
          <div className="section-heading">
            <div>
              <h2>Ваша коллекция</h2>
              <span>Всё, что вы возьмёте с собой во тьму</span>
            </div>
            <span className="count-tag">
              {hub.inventory.dice.length} / {hub.inventory.capacity}
            </span>
          </div>
          <div className="inventory-grid">
            {hub.inventory.dice.map((die) => (
              <button
                key={die.id}
                className={`inventory-slot filled ${selected?.id === die.id ? 'selected' : ''}`}
                onClick={() => setSelectedId(die.id)}
                aria-pressed={selected?.id === die.id}
              >
                <span className="slot-top">
                  УР. {die.ilvl}
                  {die.isEquipped && (
                    <span>
                      <Check size={12} />В руке
                    </span>
                  )}
                </span>
                <FlatDie face={6} />
                <strong>{BASE_NAMES[die.baseType]}</strong>
                <span className="slot-bottom">
                  <span>{die.powerScore} PS</span>
                  {die.isStarter && <ShieldCheck size={14} />}{' '}
                  {die.isLocked && <LockKeyhole size={14} />}
                </span>
              </button>
            ))}
            {Array.from(
              { length: Math.max(0, hub.inventory.capacity - hub.inventory.dice.length) },
              (_, i) => (
                <div className="inventory-slot empty" key={i}>
                  <Plus size={19} />
                  <span>Свободный слот</span>
                </div>
              ),
            )}
          </div>
          <div className="safety-note inventory-note">
            <ShieldCheck size={17} />
            <span>
              Стартовый кубик нельзя распылить. Тренировка пока не выдаёт новые предметы — обычный
              дроп появится позже.
            </span>
          </div>
        </section>
        <section className="panel inventory-details">
          {selected ? (
            <>
              <DieDetail key={selected.id} die={selected} />
              <div className="item-actions">
                <button
                  className="button secondary"
                  disabled={state.locked || !policy?.equip.allowed}
                  onClick={() =>
                    void state.submit('/api/inventory/equip', {
                      dieId: selected.id,
                      expectedRevision: revision,
                    })
                  }
                >
                  <Check size={16} />
                  {selected.isEquipped ? 'Уже в руке' : 'Экипировать'}
                </button>
                <button
                  className="button secondary"
                  disabled={state.locked}
                  onClick={() =>
                    void state.submit('/api/inventory/lock', {
                      dieId: selected.id,
                      expectedRevision: revision,
                      locked: !selected.isLocked,
                    })
                  }
                >
                  {selected.isLocked ? <UnlockKeyhole size={16} /> : <LockKeyhole size={16} />}{' '}
                  {selected.isLocked ? 'Снять защиту' : 'Защитить кубик'}
                </button>
                <button className="button primary full" onClick={() => onWorkshop(selected.id)}>
                  <Hammer size={16} />
                  Открыть в Мастерской
                </button>
                <button
                  className="text-button dismantle-button"
                  disabled={state.locked || !policy?.dismantle.allowed}
                  onClick={() =>
                    setConfirm({
                      die: structuredClone(selected),
                      revision,
                      dust: policy!.dismantle.dust,
                    })
                  }
                >
                  <Trash2 size={16} />
                  Распылить кубик
                </button>
                <p className="small-text muted">
                  {policy?.dismantle.reason ??
                    `Распыление безвозвратно удалит кубик и даст ${policy?.dismantle.dust ?? 0} пыли.`}
                </p>
              </div>
            </>
          ) : (
            <p>В сумке пока нет кубиков.</p>
          )}
        </section>
      </div>
      {confirm && (
        <Modal
          eyebrow="ОПЕРАЦИЯ С ПРЕДМЕТОМ"
          title="Распылить кубик?"
          onClose={() => setConfirm(null)}
        >
          <div className="prose">
            <p>
              <strong>{BASE_NAMES[confirm.die.baseType]}</strong> · {confirm.die.powerScore} PS
              будет удалён безвозвратно. Вы получите <strong>{confirm.dust} пыли</strong>.
            </p>
            <p>Грани, качество и аффиксы восстановить нельзя.</p>
            {revision !== confirm.revision && (
              <p role="alert">Инвентарь изменился. Закройте окно и проверьте предмет заново.</p>
            )}
            <button
              className="button primary full"
              disabled={state.locked || revision !== confirm.revision}
              onClick={() => {
                const captured = confirm;
                setConfirm(null);
                void state.submit('/api/inventory/dismantle', {
                  dieId: captured.die.id,
                  expectedRevision: captured.revision,
                  confirmed: true,
                });
              }}
            >
              Подтвердить распыление <Trash2 size={16} />
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
