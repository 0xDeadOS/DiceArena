import { create } from 'zustand';
import type { RunDTO, RunResponse } from '@dicebound/shared-types';
import { ApiError } from '../lib/api';
import type { GamePath, Mutation } from '../lib/api';
import { sessionRequest, useSession } from './session';
interface Pending extends Mutation {
  path: GamePath;
}
interface GameState {
  run: RunDTO | null;
  ready: boolean;
  busy: boolean;
  error: string | null;
  pending: Pending | null;
  load: () => Promise<void>;
  submit: (path: GamePath, body: Record<string, unknown>) => Promise<void>;
  retry: () => Promise<void>;
}
let generation = 0;
const empty = { run: null, ready: false, busy: false, error: null, pending: null };
export const useGame = create<GameState>((set, get) => {
  const allowed = () =>
    useSession.getState().mode === 'telegram' && useSession.getState().status === 'ready';
  const send = async (pending: Pending, replay = false) => {
    if (!allowed() || get().busy) return;
    const token = generation;
    set({ busy: true, pending, error: null });
    try {
      const { run } = await sessionRequest<RunResponse>(pending.path, pending);
      if (token !== generation) return;
      set({ run, pending: null, ready: true });
      // A replay may legitimately return an older cached snapshot. Restore canonical state.
      const current = replay ? await sessionRequest<RunResponse>('/api/map/current') : { run };
      if (token !== generation) return;
      set({ run: current.run, ready: true });
      if (pending.path === '/api/map/start' || current.run?.status !== 'IN_PROGRESS')
        void useSession.getState().refresh();
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
          const { run } = await sessionRequest<RunResponse>('/api/map/current');
          if (token === generation)
            set({
              run,
              ready: true,
              error: 'Поход уже изменился. Показано актуальное состояние сервера.',
            });
        } catch {
          /* Keep actions locked until a successful explicit refresh. */
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
        const { run } = await sessionRequest<RunResponse>('/api/map/current');
        if (token === generation) set({ run, ready: true });
      } catch (error) {
        if (token === generation)
          set({ error: error instanceof Error ? error.message : 'Не удалось загрузить поход.' });
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
  };
});
const scope = (state: ReturnType<typeof useSession.getState>) =>
  state.mode === 'telegram' && state.status === 'ready' ? state.hub?.player.id : null;
useSession.subscribe((next, previous) => {
  if (scope(next) !== scope(previous)) {
    generation++;
    useGame.setState({ ...empty });
  }
});
