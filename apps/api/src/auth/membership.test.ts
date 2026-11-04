import { describe, expect, it, vi } from 'vitest';
import { TelegramMembershipChecker, isCurrentMember } from './membership.js';

describe('chat membership', () => {
  it.each(['creator', 'administrator', 'member'])('allows %s', (status) =>
    expect(isCurrentMember({ status })).toBe(true),
  );
  it.each(['left', 'kicked', 'unknown'])('rejects %s', (status) =>
    expect(isCurrentMember({ status })).toBe(false),
  );
  it('requires is_member for restricted accounts', () => {
    expect(isCurrentMember({ status: 'restricted', is_member: true })).toBe(true);
    expect(isCurrentMember({ status: 'restricted', is_member: false })).toBe(false);
    expect(isCurrentMember({ status: 'restricted' })).toBe(false);
  });
  it('caches only positive results, coalesces concurrent checks and does not extend TTL on a hit', async () => {
    let now = 0;
    const fetchMember = vi.fn(async () => ({ status: 'member' }));
    const checker = new TelegramMembershipChecker({ fetchMember, clock: () => now });
    await Promise.all(Array.from({ length: 20 }, () => checker.assertMember(-1n, 1)));
    expect(fetchMember).toHaveBeenCalledTimes(1);
    now = 299_999;
    await checker.assertMember(-1n, 1);
    expect(fetchMember).toHaveBeenCalledTimes(1);
    now = 300_000;
    await checker.assertMember(-1n, 1);
    expect(fetchMember).toHaveBeenCalledTimes(2);
  });
  it('isolates room and user cache keys and evicts the least recently used entry', async () => {
    const fetchMember = vi.fn(async () => ({ status: 'member' }));
    const checker = new TelegramMembershipChecker({ fetchMember, capacity: 2 });
    await checker.assertMember(-1n, 1);
    await checker.assertMember(-1n, 2);
    await checker.assertMember(-1n, 1);
    await checker.assertMember(-2n, 1);
    await checker.assertMember(-1n, 2);
    expect(fetchMember).toHaveBeenCalledTimes(4);
  });
  it('fails closed on Telegram failure and retries rather than caching it', async () => {
    const fetchMember = vi
      .fn()
      .mockRejectedValueOnce(new Error('network with secret'))
      .mockResolvedValue({ status: 'member' });
    const checker = new TelegramMembershipChecker({ fetchMember });
    await expect(checker.assertMember(-1n, 1)).rejects.toMatchObject({
      status: 503,
      code: 'TELEGRAM_UNAVAILABLE',
    });
    await expect(checker.assertMember(-1n, 1)).resolves.toBeUndefined();
    expect(fetchMember).toHaveBeenCalledTimes(2);
  });
  it('does not cache denials', async () => {
    const fetchMember = vi
      .fn()
      .mockResolvedValueOnce({ status: 'left' })
      .mockResolvedValue({ status: 'member' });
    const checker = new TelegramMembershipChecker({ fetchMember });
    await expect(checker.assertMember(-1n, 1)).rejects.toMatchObject({ status: 403 });
    await checker.assertMember(-1n, 1);
    expect(fetchMember).toHaveBeenCalledTimes(2);
  });
});
