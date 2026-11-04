import {
  ArrowUpRight,
  Coins,
  Sparkles,
  FlaskConical,
  Infinity as InfinityIcon,
} from 'lucide-react';
import type { HubDTO, SphereType } from '@dicebound/shared-types';
import { Orb } from '../components/Orb';
import { SPHERES } from '../lib/catalog';

export function Wallet({
  hub,
  onSphere,
  onWorkshop,
}: {
  hub: HubDTO;
  onSphere: (type: SphereType) => void;
  onWorkshop: () => void;
}) {
  return (
    <div>
      <div className="section-heading">
        <div>
          <h2>Кошелёк алхимии</h2>
          <span>Каждая сфера — новая возможность</span>
        </div>
        <span className="count-tag">
          <InfinityIcon size={17} /> Без лимита
        </span>
      </div>
      <div className="wallet-resources">
        <span>
          <Coins size={18} />
          {hub.player.gold} золота
        </span>
        <span>
          <Sparkles size={18} />
          {hub.player.facetDust} пыли граней
        </span>
        <small>Пыль сохраняется для будущей Мастерской.</small>
      </div>
      <div className="wallet-grid">
        {hub.inventory.spheres.map(({ type, amount }) => (
          <button
            key={type}
            className={`wallet-card panel ${amount === 0 ? 'empty-wallet' : ''}`}
            onClick={() => onSphere(type)}
          >
            <div className="wallet-top">
              <Orb type={type} />
              <span className="wallet-amount">
                {amount}
                <small>шт.</small>
              </span>
            </div>
            <span className="eyebrow">{SPHERES[type].rarity}</span>
            <h3>{SPHERES[type].name}</h3>
            <p>{SPHERES[type].description}</p>
            <span className="text-button">
              Подробнее <ArrowUpRight size={15} />
            </span>
          </button>
        ))}
      </div>
      <div className="workshop-note">
        <FlaskConical size={25} />
        <div>
          <h3>Алхимия любит терпеливых.</h3>
          <p>Применение сфер и точная огранка появятся на третьем этапе.</p>
        </div>
        <button className="button secondary" onClick={onWorkshop}>
          О мастерской <ArrowUpRight size={15} />
        </button>
      </div>
    </div>
  );
}
