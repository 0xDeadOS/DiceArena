import type { GameEventType } from './generated/prisma/client.js';
import { json } from './transactions.js';
import type { Tx } from './transactions.js';

/**
 * Исходящая очередь анонсов. Событие создаётся в той же транзакции, что игровое изменение,
 * поэтому анонс не может появиться без факта и не теряется при повторе команды: dedupKey
 * уникален. Отправкой занимается отдельный диспетчер, игра не обращается к Bot API.
 */
export interface AnnouncementPayload {
  title: string;
  text: string;
  [key: string]: unknown;
}

export async function enqueueAnnouncement(
  tx: Tx,
  room: {
    id: string;
    eventType: GameEventType;
    dedupKey: string;
    payload: AnnouncementPayload;
    memberId?: string | null;
    now: Date;
  },
): Promise<boolean> {
  try {
    await tx.gameEvent.create({
      data: {
        roomId: room.id,
        memberId: room.memberId ?? null,
        eventType: room.eventType,
        dedupKey: room.dedupKey,
        payload: json(room.payload),
        createdAt: room.now,
      },
    });
    return true;
  } catch (error) {
    // A duplicate dedup key means the announcement for this fact already exists.
    if (
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code: string }).code === 'P2002'
    )
      return false;
    throw error;
  }
}

export const ANNOUNCEMENT_MAX_ATTEMPTS = 5;

/** 12-часовое окно для редких анонсов: один ключ на комнату на окно. */
export const cooldownWindow = (now: Date, hours: number): number =>
  Math.floor(now.getTime() / (hours * 3_600_000));

export interface PendingAnnouncement {
  id: string;
  chatId: bigint;
  canSendMessages: boolean;
  eventType: GameEventType;
  payload: AnnouncementPayload;
  attempts: number;
}

export async function claimAnnouncements(tx: Tx, limit = 20): Promise<PendingAnnouncement[]> {
  const pending = await tx.gameEvent.findMany({
    where: { sentAt: null, attempts: { lt: ANNOUNCEMENT_MAX_ATTEMPTS } },
    orderBy: { createdAt: 'asc' },
    take: limit,
    include: { room: { select: { telegramChatId: true, canSendMessages: true } } },
  });
  return pending.map((event) => ({
    id: event.id,
    chatId: event.room.telegramChatId,
    canSendMessages: event.room.canSendMessages,
    eventType: event.eventType,
    payload: event.payload as unknown as AnnouncementPayload,
    attempts: event.attempts,
  }));
}

export async function markAnnouncement(
  tx: Tx,
  id: string,
  outcome: { sent: boolean; now: Date },
): Promise<void> {
  await tx.gameEvent.update({
    where: { id },
    data: outcome.sent
      ? { sentAt: outcome.now, attempts: { increment: 1 } }
      : { attempts: { increment: 1 } },
  });
}
