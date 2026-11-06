import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { TelegramIdentity } from '@dicebound/shared-types';
import { AppError } from '../errors.js';

export interface VerifiedLaunch {
  user: TelegramIdentity;
  roomSlug: string;
  authDate: number;
  expiresAt: Date;
}

const userSchema = z.object({
  id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  first_name: z.string().min(1).max(256),
  username: z.string().max(64).optional(),
});
const invalid = () =>
  new AppError(401, 'INVALID_INIT_DATA', 'Откройте игру по кнопке /game в Telegram.');

export function verifyInitData(
  raw: string,
  botToken: string,
  now = new Date(),
  maxAgeSeconds = 86_400,
): VerifiedLaunch {
  if (!raw || Buffer.byteLength(raw, 'utf8') > 16_384 || !botToken || maxAgeSeconds < 1)
    throw invalid();
  const params = new URLSearchParams(raw);
  const keys = [...params.keys()];
  // URLSearchParams.get() alone is ambiguous for duplicate security fields.
  if (new Set(keys).size !== keys.length || keys.length > 32) throw invalid();
  const hash = params.get('hash');
  if (!hash || !/^[a-fA-F0-9]{64}$/.test(hash)) throw invalid();
  const dataCheckString = [...params.entries()]
    .filter(([key]) => key !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  // For bot-token HMAC all fields except hash are included, including signature.
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secretKey).update(dataCheckString).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw invalid();

  const dateValue = params.get('auth_date');
  if (!dateValue || !/^\d{1,12}$/.test(dateValue)) throw invalid();
  const authDate = Number(dateValue);
  const nowSeconds = Math.floor(now.getTime() / 1_000);
  if (!Number.isFinite(nowSeconds) || authDate > nowSeconds + 30) throw invalid();
  if (nowSeconds >= authDate + maxAgeSeconds) {
    throw new AppError(
      401,
      'INIT_DATA_EXPIRED',
      'Срок входа истёк. Закройте игру и снова откройте её через /game.',
    );
  }

  let parsedUser: unknown;
  try {
    parsedUser = JSON.parse(params.get('user') ?? 'null');
  } catch {
    throw invalid();
  }
  const result = userSchema.safeParse(parsedUser);
  if (!result.success) throw invalid();
  const roomSlug = params.get('start_param');
  if (!roomSlug || !/^r_[A-Za-z0-9_-]{8}$/.test(roomSlug)) {
    throw new AppError(
      400,
      'MISSING_ROOM_CONTEXT',
      'Нужна ссылка Обители. Используйте /game в групповом чате.',
    );
  }
  return {
    user: {
      id: result.data.id,
      firstName: result.data.first_name,
      username: result.data.username ?? null,
    },
    roomSlug,
    authDate,
    expiresAt: new Date((authDate + maxAgeSeconds) * 1_000),
  };
}

export function verifyAuthorization(
  header: string | undefined,
  botToken: string,
  now: Date,
  maxAgeSeconds: number,
) {
  if (!header || !/^tma /i.test(header)) throw invalid();
  return verifyInitData(header.slice(4), botToken, now, maxAgeSeconds);
}
