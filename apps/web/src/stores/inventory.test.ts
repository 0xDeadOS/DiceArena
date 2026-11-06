import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryDTO, InventoryResponse } from '@dicebound/shared-types';
import { fixtureHub } from '../../../../tests/fixtures.js';
import { fixtureInventory } from '../../../../tests/inventory-fixtures.js';
vi.mock('./session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./session')>()),
  sessionRequest: vi.fn(),
}));
import { sessionRequest, useSession } from './session';
import { useInventory } from './inventory';
import { ApiError } from '../lib/api';
const request = vi.mocked(sessionRequest);
const snapshot = (revision: number): InventoryDTO =>
  fixtureInventory({
    ...fixtureHub(),
    player: { ...fixtureHub().player, inventoryRevision: revision },
  });
const result = (revision: number): InventoryResponse => ({
  inventory: snapshot(revision),
  result: { type: 'LOCK', dieId: fixtureHub().player.equippedDieId! },
});
beforeEach(() => {
  request.mockReset();
  useSession.setState({ mode: 'demo', status: 'loading', hub: null });
  useSession.setState({ mode: 'telegram', status: 'ready', hub: fixtureHub() });
});
async function load() {
  request.mockResolvedValueOnce(snapshot(0));
  await useInventory.getState().load();
}
describe('inventory commands in the Mini App', () => {
  it('freezes consent revision and retries the identical key/body after uncertain completion', async () => {
    await load();
    request.mockRejectedValueOnce(new TypeError('lost response'));
    const body = {
      dieId: fixtureHub().player.equippedDieId,
      expectedRevision: 0,
      sphere: 'CASTING',
      confirmed: true,
    };
    await useInventory.getState().submit('/api/workshop/craft', body);
    body.expectedRevision = 10;
    const saved = useInventory.getState().pending!;
    expect(saved.body.expectedRevision).toBe(0);
    await useInventory.getState().submit('/api/inventory/lock', {});
    expect(request).toHaveBeenCalledTimes(2);
    request.mockResolvedValueOnce(result(1)).mockResolvedValueOnce(snapshot(3));
    await useInventory.getState().retry();
    expect(request.mock.calls[1]![1]).toEqual(request.mock.calls[2]![1]);
    expect(useInventory.getState()).toMatchObject({
      pending: null,
      busy: false,
      ready: true,
      inventory: { hub: { player: { inventoryRevision: 3 } } },
    });
    expect(useSession.getState().hub?.player.inventoryRevision).toBe(3);
  });
  it.each([429, 500, 503])('retains the pending nonce for HTTP %s', async (status) => {
    await load();
    request.mockRejectedValueOnce(new ApiError(status, 'RETRY', 'Повторите.'));
    await useInventory.getState().submit('/api/workshop/craft', {});
    expect(useInventory.getState().pending).not.toBeNull();
    expect(useInventory.getState().ready).toBe(false);
  });
  it('refreshes a 409 but never retries a destructive action with a newer revision automatically', async () => {
    await load();
    request
      .mockRejectedValueOnce(new ApiError(409, 'STALE_INVENTORY', 'Устарело.'))
      .mockResolvedValueOnce(snapshot(2));
    await useInventory.getState().submit('/api/inventory/dismantle', { expectedRevision: 0 });
    expect(request).toHaveBeenCalledTimes(3);
    expect(useInventory.getState()).toMatchObject({
      pending: null,
      ready: true,
      inventory: { hub: { player: { inventoryRevision: 2 } } },
    });
  });
  it('does not charge again when only the canonical read after a successful replay fails', async () => {
    await load();
    request.mockRejectedValueOnce(new Error('network'));
    await useInventory.getState().submit('/api/workshop/craft', {});
    request.mockResolvedValueOnce(result(1)).mockRejectedValueOnce(new Error('read failed'));
    await useInventory.getState().retry();
    expect(useInventory.getState()).toMatchObject({
      pending: null,
      ready: false,
      result: { type: 'LOCK' },
      error: expect.stringContaining('Действие сохранено'),
    });
    const count = request.mock.calls.length;
    await useInventory.getState().retry();
    expect(request).toHaveBeenCalledTimes(count);
  });
  it('ignores late data and protected calls after switching to demo', async () => {
    await load();
    let resolve!: (response: InventoryResponse) => void;
    request.mockReturnValueOnce(
      new Promise<InventoryResponse>((r) => {
        resolve = r;
      }),
    );
    const flight = useInventory.getState().submit('/api/workshop/craft', {});
    useSession.getState().viewDemo();
    resolve(result(1));
    await flight;
    expect(useInventory.getState()).toMatchObject({
      inventory: null,
      result: null,
      pending: null,
      ready: false,
      busy: false,
    });
    const count = request.mock.calls.length;
    await useInventory.getState().load();
    await useInventory.getState().submit('/api/workshop/craft', {});
    expect(request).toHaveBeenCalledTimes(count);
  });
  it('blocks double taps and stale snapshots after an external inventory revision update', async () => {
    await load();
    let resolve!: (response: InventoryResponse) => void;
    request.mockReturnValueOnce(
      new Promise<InventoryResponse>((r) => {
        resolve = r;
      }),
    );
    const flight = useInventory.getState().submit('/api/inventory/lock', {});
    await useInventory.getState().submit('/api/inventory/lock', {});
    expect(request).toHaveBeenCalledTimes(2);
    resolve(result(1));
    await flight;
    useSession.getState().acceptHub(snapshot(2).hub);
    expect(useInventory.getState().ready).toBe(false);
    request.mockResolvedValueOnce(snapshot(1));
    await useInventory.getState().load();
    expect(useInventory.getState().ready).toBe(false);
    expect(useSession.getState().hub?.player.inventoryRevision).toBe(2);
  });
  it('does not enable writes after a failed initial read', async () => {
    request.mockRejectedValueOnce(new Error('offline'));
    await useInventory.getState().load();
    await useInventory.getState().submit('/api/workshop/craft', {});
    expect(request).toHaveBeenCalledTimes(1);
    expect(useInventory.getState().ready).toBe(false);
  });
  it('does not retain a rejected 400 as an uncertain charge', async () => {
    await load();
    request.mockRejectedValueOnce(new ApiError(400, 'BAD_REQUEST', 'Ошибка команды.'));
    await useInventory.getState().submit('/api/workshop/craft', {});
    expect(useInventory.getState()).toMatchObject({ pending: null, ready: false });
    await useInventory.getState().retry();
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('keeps new mutations disabled when the read after a conflict also fails', async () => {
    await load();
    request
      .mockRejectedValueOnce(new ApiError(409, 'STALE_INVENTORY', 'Устарело.'))
      .mockRejectedValueOnce(new Error('offline'));
    await useInventory.getState().submit('/api/workshop/craft', {});
    expect(useInventory.getState()).toMatchObject({ pending: null, ready: false, busy: false });
    await useInventory.getState().submit('/api/inventory/lock', {});
    expect(request).toHaveBeenCalledTimes(3);
  });
  it('sends tutorial and trophy commands with frozen consent and one nonce each', async () => {
    await load();
    request.mockResolvedValueOnce({
      inventory: fixtureInventory(),
      result: { type: 'TUTORIAL_REWARD', sphere: 'CASTING', amount: 1 },
    });
    await useInventory.getState().submit('/api/tutorial/reward', {
      expectedRevision: 0,
      confirmed: true,
    });
    expect(useInventory.getState().result).toMatchObject({ type: 'TUTORIAL_REWARD', amount: 1 });
    request.mockResolvedValueOnce({
      inventory: fixtureInventory(),
      result: { type: 'SALVAGE_DROP', dieId: 'drop-1', dust: 1 },
    });
    await useInventory.getState().submit('/api/inventory/claim', {
      dropId: 'drop-1',
      expectedRevision: 0,
      action: 'DUST',
      confirmed: true,
    });
    const calls = request.mock.calls.slice(1);
    expect(calls.map((call) => call[0])).toEqual(['/api/tutorial/reward', '/api/inventory/claim']);
    expect(new Set(calls.map((call) => call[1]!.key)).size).toBe(2);
    expect(calls[1]![1]!.body).toEqual({
      dropId: 'drop-1',
      expectedRevision: 0,
      action: 'DUST',
      confirmed: true,
    });
  });
});
