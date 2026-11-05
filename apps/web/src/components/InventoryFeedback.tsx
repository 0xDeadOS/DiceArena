import { LockKeyhole, RefreshCw, ShieldCheck } from 'lucide-react';
import { useInventory } from '../stores/inventory';
import { useSession } from '../stores/session';
export function InventoryFeedback() {
  const demo = useSession((s) => s.mode) === 'demo';
  const { busy, pending, error, load, retry, inventory } = useInventory();
  return (
    <div className="inventory-feedback">
      {demo ? (
        <div className="training-notice">
          <LockKeyhole size={18} />
          <div>
            <strong>Мастерская · только просмотр</strong>
            <p>
              Ресурсы не расходуются. Чтобы изменить кубик, откройте игру через /game в Telegram.
            </p>
          </div>
        </div>
      ) : (
        <div className="run-toolbar">
          <span>
            <ShieldCheck size={16} />
            Все изменения сохраняются на сервере
          </span>
          <button className="text-button" disabled={busy} onClick={() => void load()}>
            <RefreshCw size={15} className={busy ? 'spin' : ''} />
            Обновить инвентарь
          </button>
        </div>
      )}
      {error && !demo && (
        <div className="error-banner" role="alert">
          {error}
        </div>
      )}
      {pending && !demo && (
        <div className="training-notice retry-notice" role="status">
          <RefreshCw size={18} />
          <div>
            <strong>{busy ? 'Сохраняем действие…' : 'Ответ не подтверждён'}</strong>
            <p>
              При потере связи повтор использует тот же ключ. Сфера или кубик не спишутся дважды.
            </p>
          </div>
          <button className="button secondary" disabled={busy} onClick={() => void retry()}>
            Повторить запрос
          </button>
        </div>
      )}
      {!demo && inventory?.activeRunDieId && (
        <div className="inventory-run-note">
          <ShieldCheck size={17} />
          <p>
            В текущем походе действует сохранённый снимок снаряжения. Крафт и новая экипировка
            применятся к следующему походу; кубик текущего похода нельзя распылить.
          </p>
        </div>
      )}
    </div>
  );
}
