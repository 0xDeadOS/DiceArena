import { useState } from 'react';
import { ArrowLeftRight, ShieldCheck, LockKeyhole } from 'lucide-react';
import type { DieDTO } from '@dicebound/shared-types';
import { ACTIONS, AFFIX_NAMES, BASE_NAMES, RARITY_NAMES } from '../lib/catalog';
import { FlatDie } from './Die';

export function DieDetail({ die }: { die: DieDTO }) {
  const [selected, setSelected] = useState(1);
  const faces = die.effectiveFaces ?? die.faces;
  const face = faces.find((item) => item.face === selected)!;
  const opposite = faces.find((item) => item.face === 7 - selected)!;
  const action = ACTIONS[face.action];
  const OppositeIcon = ACTIONS[opposite.action].icon;
  return (
    <div className="die-detail">
      <div className="detail-title">
        <FlatDie face={selected} />
        <div>
          <span className="eyebrow">
            {RARITY_NAMES[die.rarity]} · УР. {die.ilvl}
          </span>
          <h3>{BASE_NAMES[die.baseType]}</h3>
        </div>
        <div className="power-number">
          {die.powerScore}
          <span>СИЛА</span>
        </div>
      </div>
      <div className="detail-stats">
        <span>
          Качество <strong>{die.quality}%</strong>
        </span>
        <span>
          Аффиксы <strong>{die.affixes.length}</strong>
        </span>
        <span>
          Огранка мастера <strong>{die.masterCrafted ? 'Да' : 'Нет'}</strong>
        </span>
      </div>
      <p className="section-label">
        ШЕСТЬ ГРАНЕЙ <span>Выберите грань для осмотра</span>
      </p>
      <div className="faces-grid">
        {faces.map((item) => {
          const { icon: Icon, className, name } = ACTIONS[item.action];
          return (
            <button
              key={item.face}
              className={`face-button ${selected === item.face ? 'selected' : ''}`}
              onClick={() => setSelected(item.face)}
              aria-pressed={selected === item.face}
              aria-label={`Грань ${item.face}: ${name} ${item.value}`}
            >
              <span className="face-index">{item.face}</span>
              <Icon className={className} size={20} />
              <strong>{item.value}</strong>
              <small className="face-base">
                база {die.faces.find((f) => f.face === item.face)?.value}
              </small>
              <span>{name}</span>
            </button>
          );
        })}
      </div>
      <div className="pair-preview">
        <div>
          <span>Грань {selected}</span>
          <strong className={action.className}>
            {action.name} {face.value}
          </strong>
        </div>
        <ArrowLeftRight size={19} />
        <div>
          <span>Грань {7 - selected}</span>
          <strong className={ACTIONS[opposite.action].className}>
            <OppositeIcon size={14} />
            {ACTIONS[opposite.action].name} {opposite.value}
          </strong>
        </div>
      </div>
      <p className="muted small-text">
        Сумма противоположных граней всегда равна 7. Значения выше рассчитаны сервером с учётом
        качества, базы и аффиксов. PS — оценка потенциала, не урон за ход.
      </p>
      {die.isStarter && (
        <div className="safety-note">
          <ShieldCheck size={17} />
          <span>Ваш первый кубик защищён от распыления.</span>
        </div>
      )}
      {die.isLocked && (
        <div className="safety-note">
          <LockKeyhole size={17} />
          <span>Защита включена: крафт и распыление запрещены.</span>
        </div>
      )}
      {die.affixes.length > 0 ? (
        <div className="affix-list" aria-label="Свойства кубика">
          {die.affixes.map((affix) => (
            <div key={affix.id} className={affix.kind === 'PREFIX' ? 'prefix' : 'suffix'}>
              <span className="affix-tier">T{affix.tier}</span>
              <span>{AFFIX_NAMES[affix.id]?.name ?? affix.id}</span>
              <strong>
                +{affix.value}
                {AFFIX_NAMES[affix.id]?.percent ? '%' : ''}
              </strong>
            </div>
          ))}
        </div>
      ) : (
        <p className="no-affixes">Пока без аффиксов. Отливка добавит первые свойства.</p>
      )}
      <div className="detail-footer">
        {die.isEquipped ? 'Сейчас в руке' : 'В сумке'}
        <span>Изменения применятся в следующем походе</span>
      </div>
    </div>
  );
}
