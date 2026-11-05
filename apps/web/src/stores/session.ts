import { create } from 'zustand';
import type { HubDTO, SessionDTO } from '@dicebound/shared-types';
import { loadTelegram } from '../lib/telegram';
import { apiRequest } from '../lib/api';
import type { ApiPath, Mutation } from '../lib/api';
import { demoHub } from '../lib/demo';

interface SessionState {
  status: 'loading' | 'ready' | 'error';
  mode: 'demo' | 'telegram';
  hub: HubDTO | null;
  error: string | null;
  refreshing: boolean;
  initialize: () => Promise<void>;
  refresh: () => Promise<void>;
  viewDemo: () => void;
  acceptHub: (hub: HubDTO) => void;
}
let pending: Promise<void> | null = null;
let generation = 0;
// Sensitive initData is kept in memory only, never local/session storage or logs.
let initData = '';

export const useSession = create<SessionState>((set, get) => ({
  status: 'loading',
  mode: 'demo',
  hub: null,
  error: null,
  refreshing: false,
  initialize: () => {
    if (pending) return pending;
    const token = ++generation;
    initData = '';
    set({ status: 'loading', hub: null, error: null, refreshing: false });
    const request = (async () => {
      try {
        const telegram = await loadTelegram();
        if (token !== generation) return;
        if (!telegram?.initData) {
          get().viewDemo();
          return;
        }
        telegram.ready();
        telegram.expand();
        telegram.setHeaderColor('#141b17');
        telegram.setBackgroundColor('#141b17');
        initData = telegram.initData;
        set({ mode: 'telegram' });
        const session = await apiRequest<SessionDTO>('/api/auth/session', initData);
        if (token === generation) set({ hub: session.hub, status: 'ready' });
      } catch (error) {
        if (token !== generation) return;
        initData = '';
        set({
          status: 'error',
          error: error instanceof Error ? error.message : 'Не удалось открыть Обитель.',
        });
      }
    })().finally(() => {
      if (pending === request) pending = null;
    });
    pending = request;
    return request;
  },
  refresh: async () => {
    if (get().mode !== 'telegram' || get().status !== 'ready' || get().refreshing || !initData)
      return;
    const token = generation;
    set({ refreshing: true, error: null });
    try {
      const hub = await apiRequest<HubDTO>('/api/hub', initData);
      if (token === generation) get().acceptHub(hub);
    } catch (error) {
      if (token === generation)
        set({ error: error instanceof Error ? error.message : 'Не удалось обновить данные.' });
    } finally {
      if (token === generation) set({ refreshing: false });
    }
  },
  acceptHub: (hub) => {
    const current = get();
    if (
      current.mode === 'telegram' &&
      current.status === 'ready' &&
      current.hub?.player.id === hub.player.id &&
      hub.player.inventoryRevision >= current.hub.player.inventoryRevision
    )
      set({ hub });
  },
  viewDemo: () => {
    generation++;
    pending = null;
    initData = '';
    set({ status: 'ready', mode: 'demo', hub: demoHub(), error: null, refreshing: false });
  },
}));

/** Authorized calls without exposing initData in components or persistent storage. */
export function sessionRequest<T>(path: ApiPath, mutation?: Mutation): Promise<T> {
  if (
    useSession.getState().mode !== 'telegram' ||
    useSession.getState().status !== 'ready' ||
    !initData
  )
    return Promise.reject(new Error('Откройте игру через Telegram.'));
  return apiRequest<T>(path, initData, mutation);
}
