import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HubDTO, SessionDTO } from '@dicebound/shared-types';
import { fixtureHub } from '../../../../tests/fixtures.js';
vi.mock('../lib/telegram', () => ({ loadTelegram: vi.fn() }));
vi.mock('../lib/api', () => ({ apiRequest: vi.fn() }));
import { loadTelegram } from '../lib/telegram';
import { apiRequest } from '../lib/api';
import { sessionRequest, useSession } from './session';
const request = vi.mocked(apiRequest);
const session = (hub = fixtureHub()): SessionDTO => ({
  hub,
  authExpiresAt: '2026-11-05T12:00:00Z',
});
const sdk = {
  initData: 'test-only-signed-data',
  ready: vi.fn(),
  expand: vi.fn(),
  setHeaderColor: vi.fn(),
  setBackgroundColor: vi.fn(),
  BackButton: { show: vi.fn(), hide: vi.fn(), onClick: vi.fn(), offClick: vi.fn() },
};
beforeEach(() => {
  useSession.getState().viewDemo();
  request.mockReset();
  vi.mocked(loadTelegram).mockReset().mockResolvedValue(sdk);
});
async function enter() {
  request.mockResolvedValueOnce(session());
  await useSession.getState().initialize();
}
describe('Mini App session lifetime', () => {
  it('coalesces concurrent initialization and passes auth only through the request helper', async () => {
    request.mockResolvedValueOnce(session());
    const a = useSession.getState().initialize();
    const b = useSession.getState().initialize();
    expect(a).toBe(b);
    await Promise.all([a, b]);
    expect(request).toHaveBeenCalledTimes(1);
    expect(useSession.getState()).toMatchObject({
      mode: 'telegram',
      status: 'ready',
      hub: fixtureHub(),
    });
    request.mockResolvedValueOnce({ run: null });
    await sessionRequest('/api/map/current');
    expect(request).toHaveBeenLastCalledWith('/api/map/current', sdk.initData, undefined);
  });
  it('without Telegram remains an explicit demo and rejects protected requests', async () => {
    vi.mocked(loadTelegram).mockResolvedValueOnce(undefined);
    await useSession.getState().initialize();
    expect(useSession.getState().mode).toBe('demo');
    await expect(sessionRequest('/api/map/current')).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });
  it('does not hide a failed Telegram login behind a demo profile', async () => {
    request.mockRejectedValueOnce(new Error('Нет доступа.'));
    await useSession.getState().initialize();
    expect(useSession.getState()).toMatchObject({
      mode: 'telegram',
      status: 'error',
      hub: null,
      error: 'Нет доступа.',
    });
    await expect(sessionRequest('/api/map/current')).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('ignores a late hub response after the user switches to demo', async () => {
    await enter();
    let resolve!: (hub: HubDTO) => void;
    request.mockReturnValueOnce(
      new Promise<HubDTO>((r) => {
        resolve = r;
      }),
    );
    const flight = useSession.getState().refresh();
    useSession.getState().viewDemo();
    const demo = useSession.getState().hub;
    resolve(fixtureHub());
    await flight;
    expect(useSession.getState()).toMatchObject({ mode: 'demo', hub: demo, refreshing: false });
  });
  it('ignores a late refresh error after reauthorization to another profile', async () => {
    await enter();
    let reject!: (error: Error) => void;
    request.mockReturnValueOnce(
      new Promise<HubDTO>((_resolve, r) => {
        reject = r;
      }),
    );
    const flight = useSession.getState().refresh();
    const hub = { ...fixtureHub(), player: { ...fixtureHub().player, id: 'new-member' } };
    request.mockResolvedValueOnce(session(hub));
    await useSession.getState().initialize();
    reject(new Error('Old request failed'));
    await flight;
    expect(useSession.getState()).toMatchObject({
      status: 'ready',
      hub,
      error: null,
      refreshing: false,
    });
  });
  it('late login completion cannot replace a newer session or clear its in-flight guard', async () => {
    let first!: (data: SessionDTO) => void;
    let second!: (data: SessionDTO) => void;
    request
      .mockReturnValueOnce(
        new Promise<SessionDTO>((r) => {
          first = r;
        }),
      )
      .mockReturnValueOnce(
        new Promise<SessionDTO>((r) => {
          second = r;
        }),
      );
    const old = useSession.getState().initialize();
    await Promise.resolve();
    useSession.getState().viewDemo();
    const fresh = useSession.getState().initialize();
    await Promise.resolve();
    first(session());
    await old;
    expect(useSession.getState().status).toBe('loading');
    expect(useSession.getState().initialize()).toBe(fresh);
    const hub = { ...fixtureHub(), player: { ...fixtureHub().player, id: 'new-member' } };
    second(session(hub));
    await fresh;
    expect(useSession.getState().hub).toEqual(hub);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
