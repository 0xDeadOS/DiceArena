import { create } from 'zustand';
import type { InventoryDTO, InventoryResponse, InventoryResult } from '@dicebound/shared-types';
import { ApiError } from '../lib/api';
import type { InventoryPath, Mutation } from '../lib/api';
import { sessionRequest, useSession } from './session';
interface Pending extends Mutation {
  path: InventoryPath;
}
interface InventoryState {
  inventory: InventoryDTO | null;
  result: InventoryResult | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  pending: Pending | null;
  load: () => Promise<void>;
  submit: (path: InventoryPath, body: Record<string, unknown>) => Promise<void>;
  retry: () => Promise<void>;
  clearResult: () => void;
}
let generation = 0;
const empty = {
  inventory: null,
  result: null,
  ready: false,
  busy: false,
  error: null,
  pending: null,
};
export const useInventory = create<InventoryState>((set, get) => {
  const allowed = () =>
    useSession.getState().mode === 'telegram' && useSession.getState().status === 'ready';
  const accept = (inventory: InventoryDTO) => {
    const hub = useSession.getState().hub;
    if (
      !hub ||
      inventory.hub.player.id !== hub.player.id ||
      inventory.hub.player.inventoryRevision < hub.player.inventoryRevision
    ) {
      set({ ready: false, error: 'Ресурсы уже изменились. Обновите инвентарь.' });
      return;
    }
    set({ inventory, ready: true });
    useSession.getState().acceptHub(inventory.hub);
  };
  const send = async (pending: Pending, replay = false) => {
    if (!allowed() || get().busy) return;
    const token = generation;
    set({ busy: true, pending, error: null });
    try {
      const response = await sessionRequest<InventoryResponse>(pending.path, pending);
      if (token !== generation) return;
      set({ pending: null, result: response.result });
      const newer =
        (useSession.getState().hub?.player.inventoryRevision ?? 0) >
        response.inventory.hub.player.inventoryRevision;
      const inventory =
        replay || newer ? await sessionRequest<InventoryDTO>('/api/inventory') : response.inventory;
      if (token === generation) accept(inventory);
    } catch (error) {
      if (token !== generation) return;
      const confirmed = !get().pending;
      const retryable = !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
      const message = confirmed
        ? 'Действие сохранено, но не удалось обновить инвентарь. Обновите данные; повторное списание не требуется.'
        : error instanceof ApiError
          ? error.message
          : 'Связь прервалась. Действие могло выполниться на сервере.';
      set({ ready: false, error: message, ...(!retryable ? { pending: null } : {}) });
      if (!confirmed && error instanceof ApiError && error.status === 409) {
        try {
          const inventory = await sessionRequest<InventoryDTO>('/api/inventory');
          if (token === generation) {
            accept(inventory);
            set({
              error: 'Инвентарь обновлён. Проверьте предмет и подтвердите новое действие ещё раз.',
            });
          }
        } catch {
          /* A failed read leaves all new writes disabled. */
        }
      }
    } finally {
      if (token === generation) set({ busy: false });
    }
  };
  return {
    ...empty,
    load: async () => {
      if (!allowed() || get().busy) return;
      const token = generation;
      set({ busy: true, ready: false, error: null });
      try {
        const inventory = await sessionRequest<InventoryDTO>('/api/inventory');
        if (token === generation) accept(inventory);
      } catch (error) {
        if (token === generation)
          set({ error: error instanceof Error ? error.message : 'Не удалось открыть инвентарь.' });
      } finally {
        if (token === generation) set({ busy: false });
      }
    },
    submit: async (path, body) => {
      if (!allowed() || !get().ready || get().busy || get().pending) return;
      await send({ path, body: structuredClone(body), key: crypto.randomUUID() });
    },
    retry: async () => {
      const pending = get().pending;
      if (pending) await send(pending, true);
    },
    clearResult: () => set({ result: null }),
  };
});
const scope = (state: ReturnType<typeof useSession.getState>) =>
  state.mode === 'telegram' && state.status === 'ready' ? state.hub?.player.id : null;
useSession.subscribe((next, previous) => {
  if (scope(next) !== scope(previous)) {
    generation++;
    useInventory.setState({ ...empty });
  } else if (
    next.hub &&
    useInventory.getState().inventory &&
    next.hub.player.inventoryRevision >
      useInventory.getState().inventory!.hub.player.inventoryRevision
  )
    useInventory.setState({
      ready: false,
      error: 'Ресурсы изменились. Обновите инвентарь перед следующим действием.',
    });
});
