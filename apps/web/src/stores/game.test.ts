import { beforeEach, describe, it, expect, vi } from 'vitest';
import { fixtureHub } from '../../../../tests/fixtures.js';
import { fixtureRun } from '../../../../tests/game-fixtures.js';
import type { RunResponse } from '@dicebound/shared-types';
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  sessionRequest: vi.fn(),
}));
import { useSession, sessionRequest } from './session';
import { useGame } from './game';
import { ApiError } from '../lib/api';
const request = vi.mocked(sessionRequest);
beforeEach(() => {
  request.mockReset();
  useSession.setState({ mode: 'demo', status: 'loading', hub: null });
  useSession.setState({
    mode: 'telegram',
    status: 'ready',
    hub: fixtureHub(),
    refresh: vi.fn(async () => {}),
  });
});
async function load() {
  request.mockResolvedValueOnce({ run: fixtureRun() });
  await useGame.getState().load();
}
describe('Mini App command retry state', () => {
  it('keeps the exact nonce and frozen body after ambiguous network failure', async () => {
    await load();
    request.mockRejectedValueOnce(new TypeError('Network unavailable'));
    const body = {
      runId: fixtureRun().id,
      expectedRevision: 2,
      battleId: fixtureRun().battle!.id,
      action: 'DIRECT',
    };
    await useGame.getState().submit('/api/battle/decision', body);
    body.expectedRevision = 99;
    const pending = useGame.getState().pending!;
    expect(pending.key).toMatch(/^[a-f0-9-]{36}$/);
    expect(pending.body.expectedRevision).toBe(2);
    expect(useGame.getState().ready).toBe(false);
    await useGame.getState().submit('/api/map/start', {});
    expect(request).toHaveBeenCalledTimes(2);
    request
      .mockResolvedValueOnce({ run: { ...fixtureRun(), revision: 3 } })
      .mockResolvedValueOnce({ run: { ...fixtureRun(), revision: 9 } });
    await useGame.getState().retry();
    expect(request.mock.calls[1]![1]).toEqual(request.mock.calls[2]![1]);
    expect(useGame.getState()).toMatchObject({
      pending: null,
      ready: true,
      busy: false,
      run: { revision: 9 },
    });
  });
  it('refreshes the wallet after a paid ordinary start and keeps the frozen consent body', async () => {
    await load();
    const refresh = vi.fn(async () => {});
    useSession.setState({ refresh });
    request.mockResolvedValueOnce({ run: { ...fixtureRun(), mode: 'EXPEDITION', level: 3 } });
    const body = { level: 3, expectedInventoryRevision: 0, confirmed: true };
    await useGame.getState().submit('/api/expedition/start', body);
    body.level = 9;
    expect(request.mock.calls[1]![1]).toMatchObject({
      body: { level: 3, expectedInventoryRevision: 0, confirmed: true },
    });
    expect(useGame.getState().run).toMatchObject({ mode: 'EXPEDITION', level: 3 });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
  it.each([429, 500, 503])('retains a pending command on retryable HTTP %s', async (status) => {
    await load();
    request.mockRejectedValueOnce(new ApiError(status, 'TEMPORARY', 'Позже.'));
    await useGame
      .getState()
      .submit('/api/map/retreat', { runId: fixtureRun().id, expectedRevision: 2 });
    expect(useGame.getState().pending).not.toBeNull();
    expect(useGame.getState().ready).toBe(false);
  });
  it('handles stale state by loading canonical data and discarding the rejected command', async () => {
    await load();
    request
      .mockRejectedValueOnce(new ApiError(409, 'STALE_STATE', 'Обновите.'))
      .mockResolvedValueOnce({ run: { ...fixtureRun(), revision: 4 } });
    await useGame
      .getState()
      .submit('/api/map/retreat', { runId: fixtureRun().id, expectedRevision: 2 });
    expect(useGame.getState()).toMatchObject({ pending: null, ready: true, run: { revision: 4 } });
  });
  it('does not resend a known-successful mutation if only its follow-up read failed', async () => {
    await load();
    request.mockRejectedValueOnce(new TypeError('Network'));
    await useGame.getState().submit('/api/battle/roll', {});
    request
      .mockResolvedValueOnce({ run: fixtureRun() })
      .mockRejectedValueOnce(new TypeError('Read failed'));
    await useGame.getState().retry();
    expect(useGame.getState()).toMatchObject({ pending: null, ready: false });
    const count = request.mock.calls.length;
    await useGame.getState().retry();
    expect(request).toHaveBeenCalledTimes(count);
  });
  it('suppresses double taps while a write is in flight', async () => {
    await load();
    let resolve!: (response: RunResponse) => void;
    request.mockReturnValueOnce(
      new Promise<RunResponse>((r) => {
        resolve = r;
      }),
    );
    const first = useGame.getState().submit('/api/battle/roll', {});
    const second = useGame.getState().submit('/api/battle/roll', {});
    expect(request).toHaveBeenCalledTimes(2);
    resolve({ run: fixtureRun() });
    await Promise.all([first, second]);
    expect(useGame.getState().busy).toBe(false);
  });
  it('never calls protected APIs in demo and discards late responses after identity changes', async () => {
    await load();
    let resolve!: (response: RunResponse) => void;
    request.mockReturnValueOnce(
      new Promise<RunResponse>((r) => {
        resolve = r;
      }),
    );
    const flight = useGame.getState().submit('/api/battle/roll', {});
    useSession.setState({ mode: 'demo' });
    resolve({ run: fixtureRun() });
    await flight;
    expect(useGame.getState()).toMatchObject({
      run: null,
      pending: null,
      ready: false,
      busy: false,
    });
    const count = request.mock.calls.length;
    await useGame.getState().load();
    await useGame.getState().submit('/api/map/start', {});
    expect(request).toHaveBeenCalledTimes(count);
  });
});
