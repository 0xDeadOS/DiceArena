import { ArrowRight, Check, X } from 'lucide-react';
import type { InventoryResult } from '@dicebound/shared-types';
import { DieDetail } from './DieDetail';
import { ACTIONS, SPHERES } from '../lib/catalog';
const ACTION_NAMES = Object.fromEntries(
  Object.entries(ACTIONS).map(([key, value]) => [key, value.name]),
) as Record<string, string>;
export function CraftResult({ result, onClose }: { result: InventoryResult; onClose: () => void }) {
  if (result.type !== 'CRAFT' && result.type !== 'MASTER_FACET')
    return (
      <div className="inventory-success" role="status">
        <Check size={18} />
        <span>
          {result.type === 'TUTORIAL_REWARD'
            ? 'Учебная Отливка получена: +1 сфера.'
            : result.type === 'TUTORIAL_COMPLETE'
              ? 'Обучение завершено. Обычные экспедиции открыты.'
              : result.type === 'CLAIM_DROP'
                ? 'Трофей добавлен в сумку.'
                : result.type === 'EQUIP'
                  ? 'Кубик экипирован.'
                  : result.type === 'LOCK'
                    ? 'Защита кубика обновлена.'
                    : `Кубик распылён: +${result.dust} пыли.`}
        </span>
        <button className="icon-button" aria-label="Скрыть результат" onClick={onClose}>
          <X size={15} />
        </button>
      </div>
    );
  const delta = result.after.powerScore - result.before.powerScore;
  return (
    <section className="craft-result panel" aria-label="Результат крафта">
      <div className="craft-result-heading">
        <span>
          <Check size={17} />
          {result.type === 'CRAFT' ? 'Результат уже сохранён' : 'Огранка сохранена'}
        </span>
        <button className="icon-button" aria-label="Скрыть результат" onClick={onClose}>
          <X size={16} />
        </button>
      </div>
      <div className="craft-score-change">
        <div>
          <small>ДО</small>
          <strong>
            {result.before.powerScore}
            <span>PS</span>
          </strong>
        </div>
        <ArrowRight size={24} />
        <div>
          <small>ПОСЛЕ</small>
          <strong>
            {result.after.powerScore}
            <span>PS</span>
          </strong>
        </div>
        <span className={delta < 0 ? 'score-loss' : 'score-gain'}>
          {delta > 0 ? '+' : ''}
          {delta} PS
        </span>
      </div>
      <p className="small-text muted">
        {result.type === 'CRAFT'
          ? `Потрачена 1 ${SPHERES[result.sphere].name.toLowerCase()}.`
          : `Мастер огранел грань ${result.face}: ${ACTION_NAMES[result.action]} за ${result.dust} пыли.`}{' '}
        Это снимок результата операции. Новая конфигурация подтвердится победой в новом походе.
      </p>
      <div className="craft-comparison">
        <details>
          <summary>Кубик до изменения</summary>
          <DieDetail die={result.before} />
        </details>
        <details>
          <summary>Кубик после изменения</summary>
          <DieDetail die={result.after} />
        </details>
      </div>
    </section>
  );
}
