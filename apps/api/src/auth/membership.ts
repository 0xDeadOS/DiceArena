import { AppError } from '../errors.js';

export interface TelegramMemberInfo {
  status: string;
  is_member?: boolean;
}
export interface MembershipChecker {
  assertMember(chatId: bigint, userId: number): Promise<void>;
}
export interface MembershipOptions {
  fetchMember: (chatId: bigint, userId: number) => Promise<TelegramMemberInfo>;
  clock?: () => number;
  ttlMs?: number;
  capacity?: number;
}

export function isCurrentMember(member: TelegramMemberInfo): boolean {
  return (
    ['creator', 'administrator', 'member'].includes(member.status) ||
    (member.status === 'restricted' && member.is_member === true)
  );
}

/** Positive-only, bounded LRU cache. Concurrent misses share one Bot API call. */
export class TelegramMembershipChecker implements MembershipChecker {
  private readonly cache = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly capacity: number;

  constructor(private readonly options: MembershipOptions) {
    this.clock = options.clock ?? Date.now;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.capacity = options.capacity ?? 5_000;
    if (this.ttlMs <= 0 || this.capacity < 1)
      throw new RangeError('Invalid membership cache settings');
  }

  async assertMember(chatId: bigint, userId: number): Promise<void> {
    const key = `${chatId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached !== undefined && cached > this.clock()) {
      this.cache.delete(key);
      this.cache.set(key, cached); // Touch without extending the five-minute TTL.
      return;
    }
    this.cache.delete(key);
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    if (this.inFlight.size >= this.capacity) {
      throw new AppError(
        503,
        'TELEGRAM_UNAVAILABLE',
        'Проверка членства перегружена. Попробуйте позже.',
      );
    }
    const pending = this.fetchAndCache(key, chatId, userId);
    this.inFlight.set(key, pending);
    try {
      await pending;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async fetchAndCache(key: string, chatId: bigint, userId: number) {
    let member: TelegramMemberInfo;
    try {
      member = await this.options.fetchMember(chatId, userId);
    } catch {
      throw new AppError(
        503,
        'TELEGRAM_UNAVAILABLE',
        'Не удалось проверить членство в чате. Попробуйте ещё раз.',
      );
    }
    if (!isCurrentMember(member)) {
      throw new AppError(
        403,
        'NOT_A_ROOM_MEMBER',
        'Эта Обитель доступна только участникам её Telegram-чата.',
      );
    }
    while (this.cache.size >= this.capacity) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    this.cache.set(key, this.clock() + this.ttlMs);
  }
}
