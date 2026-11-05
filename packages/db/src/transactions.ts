import { createHash } from 'node:crypto';
import { requireRule } from '@dicebound/game-core';
import type { RoomContext, TelegramIdentity } from '@dicebound/shared-types';
import type { Prisma, PrismaClient, RoomMember } from './generated/prisma/client.js';
export type Tx = Prisma.TransactionClient;
export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
export async function lockMember(
  tx: Tx,
  room: RoomContext,
  identity: TelegramIdentity,
): Promise<RoomMember> {
  const found = await tx.roomMember.findFirst({
    where: { roomId: room.id, user: { telegramUserId: BigInt(identity.id) } },
    select: { id: true },
  });
  requireRule(found, 'SESSION_REQUIRED', 'Сначала откройте игровую сессию.');
  await tx.$queryRaw`SELECT id FROM "RoomMember" WHERE id=${found.id}::uuid FOR UPDATE`;
  return tx.roomMember.findUniqueOrThrow({ where: { id: found.id } });
}
/** Shared nonce namespace per owner, distinct operation fingerprints, atomic successful response. */
export async function memberCommand<T>(
  db: PrismaClient,
  room: RoomContext,
  identity: TelegramIdentity,
  namespace: string,
  command: unknown,
  key: string,
  now: Date,
  apply: (tx: Tx, member: RoomMember) => Promise<T>,
): Promise<T> {
  requireRule(
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key),
    'INVALID_IDEMPOTENCY_KEY',
    'Нужен UUIDv4 Idempotency-Key.',
  );
  return db.$transaction(async (tx) => {
    const member = await lockMember(tx, room, identity);
    const hash = createHash('sha256')
      .update(`${namespace}:${canonical(command)}`)
      .digest('hex');
    const previous = await tx.idempotencyRecord.findUnique({
      where: { memberId_key: { memberId: member.id, key } },
    });
    if (previous) {
      requireRule(
        previous.requestHash === hash,
        'IDEMPOTENCY_CONFLICT',
        'Этот ключ уже использован для другого действия.',
      );
      requireRule(
        previous.expiresAt > now && previous.responseStatus === 200,
        'IDEMPOTENCY_EXPIRED',
        'Срок повтора истёк. Обновите состояние.',
      );
      return previous.responseBody as unknown as T;
    }
    await tx.idempotencyRecord.updateMany({
      where: { memberId: member.id, expiresAt: { lte: now }, responseStatus: 200 },
      data: { responseStatus: 409, responseBody: { expired: true } },
    });
    const response = await apply(tx, member);
    await tx.idempotencyRecord.create({
      data: {
        memberId: member.id,
        key,
        requestHash: hash,
        responseStatus: 200,
        responseBody: json(response),
        createdAt: now,
        expiresAt: new Date(now.getTime() + 86_400_000),
      },
    });
    return response;
  });
}
