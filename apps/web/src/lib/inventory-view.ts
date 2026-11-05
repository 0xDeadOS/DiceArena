import { useEffect } from 'react';
import { SPHERE_TYPES } from '@dicebound/shared-types';
import type { HubDTO, InventoryDTO } from '@dicebound/shared-types';
import { useInventory } from '../stores/inventory';
import { useSession } from '../stores/session';
/** Static view policies only. Browser preview never evaluates or executes a craft. */
function readonlyInventory(
  hub: HubDTO,
  reason = 'Доступно после входа через Telegram.',
): InventoryDTO {
  return {
    hub,
    activeRunDieId: null,
    powerScoreModel: 'ETV_PASSIVE_V1',
    policies: hub.inventory.dice.map((die) => ({
      dieId: die.id,
      equip: { allowed: false, reason },
      dismantle: {
        allowed: false,
        reason: die.isStarter ? 'Стартовый кубик нельзя распылить.' : reason,
        dust: 0,
      },
      craft: SPHERE_TYPES.map((sphere) => ({
        sphere,
        cost: 1,
        allowed: false,
        reason,
        destructive: ['FACETING', 'RESHAPING', 'CLEANSING'].includes(sphere),
      })),
    })),
  };
}
export function useInventoryView() {
  const mode = useSession((s) => s.mode);
  const hub = useSession((s) => s.hub)!;
  const state = useInventory();
  const demo = mode === 'demo';
  useEffect(() => {
    if (!demo) void state.load();
  }, [demo, state.load]);
  const inventory = demo
    ? readonlyInventory(hub)
    : (state.inventory ?? readonlyInventory(hub, 'Дождитесь загрузки данных с сервера.'));
  return {
    ...state,
    inventory,
    demo,
    locked: demo || !state.ready || state.busy || !!state.pending,
  };
}
