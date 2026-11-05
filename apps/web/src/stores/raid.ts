import { create } from 'zustand';
import type { LeaderboardDTO, RaidDTO } from '@dicebound/shared-types';
import { ApiError } from '../lib/api';
import type { Mutation, RaidPath } from '../lib/api';
import { sessionRequest, useSession } from './session';

interface Pending extends Mutation {
  path: RaidPath;
}

interface RaidState {
  raid: RaidDTO | null;
  leaderboard: LeaderboardDTO | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  pending: Pending | null;
  load: () => Promise<void>;
  loadLeaderboard: () => Promise<void>;
  submit: (path: RaidPath, body: Record<string, unknown>) => Promise<void>;
  retry: () => Promise<void>;
}

let generation = 0;
const empty = {
  raid: null,
  leaderboard: null,
  ready: false,
  busy: false,
  error: null,
  pending: null,
};

export const useRaid = create<RaidState>((set, get) => {
  const allowed = () =>
    useSession.getState().mode === 'telegram' && useSession.getState().status === 'ready';

  const send = async (pending: Pending, replay = false) => {
    if (!allowed() || get().busy) return;
    const token = generation;
    set({ busy: true, pending, error: null });
    try {
      const raid = await sessionRequest<RaidDTO>(pending.path, pending);
      if (token !== generation) return;
      set({ raid, pending: null, ready: true });
      // Повтор по тому же ключу может вернуть кэшированный снимок — обновляем канонический.
      const current = replay ? await sessionRequest<RaidDTO>('/api/raid') : raid;
      if (token !== generation) return;
      set({ raid: current, ready: true });
    } catch (error) {
      if (token !== generation) return;
      const message =
        error instanceof ApiError
          ? error.message
          : 'Связь прервалась. Запрос мог выполниться на сервере.';
      const retryable = !(error instanceof ApiError) || error.status >= 500 || error.status === 429;
      set({ error: message, ready: false, ...(!retryable ? { pending: null } : {}) });
      if (error instanceof ApiError && error.status === 409) {
        try {
          const raid = await sessionRequest<RaidDTO>('/api/raid');
          if (token === generation)
            set({
              raid,
              ready: true,
              error: 'Рейд уже изменился. Показано актуальное состояние Обители.',
            });
        } catch {
          /* Держим действия заблокированными до явного обновления. */
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
      set({ busy: true, error: null });
      try {
        const raid = await sessionRequest<RaidDTO>('/api/raid');
        if (token === generation) set({ raid, ready: true });
      } catch (error) {
        if (token === generation)
          set({
            error: error instanceof ApiError ? error.message : 'Не удалось загрузить рейд Обители.',
            ready: false,
          });
      } finally {
        if (token === generation) set({ busy: false });
      }
    },
    loadLeaderboard: async () => {
      if (!allowed()) return;
      const token = generation;
      try {
        const leaderboard = await sessionRequest<LeaderboardDTO>('/api/leaderboard');
        if (token === generation) set({ leaderboard });
      } catch (error) {
        if (token === generation)
          set({
            error:
              error instanceof ApiError ? error.message : 'Не удалось загрузить зал славы Обители.',
          });
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
  };
});

const scope = (state: ReturnType<typeof useSession.getState>) =>
  state.mode === 'telegram' && state.status === 'ready' ? state.hub?.player.id : null;

useSession.subscribe((next, previous) => {
  if (scope(next) !== scope(previous)) {
    generation++;
    useRaid.setState({ ...empty });
  }
});
