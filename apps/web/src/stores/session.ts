import { create } from 'zustand';
import type { HubDTO, SessionDTO } from '@dicebound/shared-types';
import { loadTelegram } from '../lib/telegram';
import { apiRequest } from '../lib/api';
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
}
let pending: Promise<void> | null = null;
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
    pending = (async () => {
      set({ status: 'loading', error: null });
      try {
        const telegram = await loadTelegram();
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
        set({ hub: session.hub, status: 'ready' });
      } catch (error) {
        set({
          status: 'error',
          error: error instanceof Error ? error.message : 'Не удалось открыть Обитель.',
        });
      }
    })().finally(() => {
      pending = null;
    });
    return pending;
  },
  refresh: async () => {
    if (get().mode === 'demo' || get().refreshing) return;
    set({ refreshing: true, error: null });
    try {
      set({ hub: await apiRequest<HubDTO>('/api/hub', initData) });
    } catch (error) {
      set({ error: error instanceof Error ? error.message : 'Не удалось обновить данные.' });
    } finally {
      set({ refreshing: false });
    }
  },
  viewDemo: () => {
    initData = '';
    set({ status: 'ready', mode: 'demo', hub: demoHub(), error: null });
  },
}));
