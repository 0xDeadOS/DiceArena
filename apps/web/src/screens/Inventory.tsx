import { Check, LockKeyhole, Plus, ShieldCheck } from 'lucide-react';
import type { HubDTO } from '@dicebound/shared-types';
import { useState } from 'react';
import { FlatDie } from '../components/Die';
import { DieDetail } from '../components/DieDetail';
import { BASE_NAMES } from '../lib/catalog';

export function Inventory({ hub }: { hub: HubDTO }) {
  const [selectedId, setSelectedId] = useState(hub.player.equippedDieId);
  const selected = hub.inventory.dice.find((die) => die.id === selectedId) ?? hub.inventory.dice[0];
  return (
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
                    <Check size={12} /> В руке
                  </span>
                )}
              </span>
              <FlatDie face={6} />
              <strong>{BASE_NAMES[die.baseType]}</strong>
              <span className="slot-bottom">
                <span>{die.powerScore} PS</span>
                {die.isStarter && <ShieldCheck size={14} />}
              </span>
            </button>
          ))}
          {Array.from(
            { length: Math.max(0, hub.inventory.capacity - hub.inventory.dice.length) },
            (_, index) => (
              <div className="inventory-slot empty" key={`empty-${index}`}>
                <Plus size={19} />
                <span>Свободный слот</span>
              </div>
            ),
          )}
        </div>
        <div className="safety-note inventory-note">
          <LockKeyhole size={17} />
          <span>
            Стартовый кубик всегда остаётся с вами. Новые артефакты будут доступны с запуском
            походов.
          </span>
        </div>
      </section>
      <section className="panel inventory-details">
        {selected ? (
          <DieDetail key={selected.id} die={selected} />
        ) : (
          <p>В сумке пока нет кубиков.</p>
        )}
      </section>
    </div>
  );
}
