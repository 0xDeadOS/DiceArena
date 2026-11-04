import type { RoomContext } from '@dicebound/shared-types';
import type { PrismaClient } from './generated/prisma/client.js';

export interface RoomRepository {
  ensureRoom(chatId: bigint, title: string, slug: string): Promise<RoomContext>;
  migrateChat(oldChatId: bigint, newChatId: bigint): Promise<void>;
  setCanSendMessages(chatId: bigint, allowed: boolean): Promise<void>;
}

export class PrismaRoomRepository implements RoomRepository {
  constructor(private readonly db: PrismaClient) {}

  ensureRoom(chatId: bigint, title: string, slug: string): Promise<RoomContext> {
    return this.db.room.upsert({
      where: { telegramChatId: chatId },
      create: { telegramChatId: chatId, title, slug },
      update: { title, canSendMessages: true },
      select: { id: true, slug: true, title: true, telegramChatId: true },
    });
  }

  async migrateChat(oldChatId: bigint, newChatId: bigint) {
    // A unique-ID conflict fails instead of silently overwriting another room.
    await this.db.room.updateMany({
      where: { telegramChatId: oldChatId },
      data: { telegramChatId: newChatId },
    });
  }

  async setCanSendMessages(chatId: bigint, allowed: boolean) {
    await this.db.room.updateMany({
      where: { telegramChatId: chatId },
      data: { canSendMessages: allowed },
    });
  }
}
