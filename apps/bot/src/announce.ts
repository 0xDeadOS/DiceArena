import type { PrismaClient } from '@dicebound/db';
import { claimAnnouncements, markAnnouncement } from '@dicebound/db';

export interface AnnouncementSender {
  (chatId: bigint, text: string): Promise<unknown>;
}

export interface DispatcherOptions {
  db: PrismaClient;
  send: AnnouncementSender;
  clock?: () => Date;
  intervalMs?: number;
  log?: (message: string) => void;
}

/**
 * Исходящая очередь анонсов. Игра только складывает события в очередь в одной транзакции
 * с изменением состояния; отправляет отдельный диспетчер, поэтому сбой Bot API не откатывает
 * рейд и не блокирует игру.
 *
 * - Чат запретил сообщения (`canSendMessages = false`) — событие помечается отправленным
 *   и не повторяется: уважение к настройке важнее доставки.
 * - Ошибка отправки увеличивает `attempts`; после пяти попыток событие больше не берётся.
 * - Одна итерация обрабатывает пачку и не падает на отдельном сообщении.
 */
export function startAnnouncementDispatcher(options: DispatcherOptions): () => void {
  const clock = options.clock ?? (() => new Date());
  const interval = options.intervalMs ?? 15_000;
  const log = options.log ?? (() => undefined);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const drain = async () => {
    if (stopped) return;
    try {
      await options.db.$transaction(async (tx) => {
        const pending = await claimAnnouncements(tx);
        for (const event of pending) {
          if (!event.canSendMessages) {
            await markAnnouncement(tx, event.id, { sent: true, now: clock() });
            continue;
          }
          try {
            await options.send(event.chatId, `${event.payload.title}\n\n${event.payload.text}`);
            await markAnnouncement(tx, event.id, { sent: true, now: clock() });
          } catch (error) {
            await markAnnouncement(tx, event.id, { sent: false, now: clock() });
            log(
              `Announcement ${event.id} (${event.eventType}) failed on attempt ${event.attempts + 1}: ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
        }
      });
    } catch (error) {
      log(
        `Announcement dispatcher iteration failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      if (!stopped) timer = setTimeout(() => void drain(), interval);
    }
  };

  timer = setTimeout(() => void drain(), 0);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
