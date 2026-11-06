import { describe, expect, it, vi } from 'vitest';
import type { Update, ChatMember } from 'grammy/types';
import { buildBot, canBotSendMessages } from './bot.js';
import { miniAppUrl } from './commands/game.js';
import { ROOM, TEST_TOKEN } from '../../../tests/fixtures.js';

function setup(admin = true) {
  const rooms = {
    ensureRoom: vi.fn(async () => ROOM),
    migrateChat: vi.fn(async () => undefined),
    setCanSendMessages: vi.fn(async () => undefined),
  };
  const sent: Record<string, unknown>[] = [];
  const bot = buildBot(TEST_TOKEN, 'dicebound', rooms);
  bot.botInfo = {
    id: 123456789,
    is_bot: true,
    first_name: 'Dicebound',
    username: 'DiceboundBot',
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: true,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
  bot.api.config.use(async (_prev, method, payload) => {
    if (method === 'getChatMember')
      return {
        ok: true,
        result: { status: admin ? 'administrator' : 'member', user: bot.botInfo },
      } as never;
    if (method === 'getChat')
      return {
        ok: true,
        result: {
          id: Number(ROOM.telegramChatId),
          type: 'supergroup',
          title: ROOM.title,
          permissions: { can_send_messages: false },
        },
      } as never;
    if (method === 'sendMessage') {
      sent.push(payload as Record<string, unknown>);
      return { ok: true, result: { message_id: 1 } } as never;
    }
    throw new Error(`Unexpected API call: ${method}`);
  });
  return { bot, rooms, sent };
}
function messageUpdate(message: Record<string, unknown> = {}): Update {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      date: 1,
      chat: { id: Number(ROOM.telegramChatId), type: 'supergroup', title: ROOM.title },
      from: { id: 42, is_bot: false, first_name: 'Alice' },
      text: '/game',
      entities: [{ type: 'bot_command', offset: 0, length: 5 }],
      ...message,
    },
  } as Update;
}

describe('Telegram bot', () => {
  it('uses an ordinary URL button with the persisted slug, never a group web_app button', async () => {
    const { bot, rooms, sent } = setup();
    await bot.handleUpdate(messageUpdate());
    expect(rooms.ensureRoom).toHaveBeenCalledWith(
      ROOM.telegramChatId,
      ROOM.title,
      expect.stringMatching(/^r_[A-Za-z0-9_-]{8}$/),
    );
    expect(sent[0]?.reply_markup).toEqual({
      inline_keyboard: [
        [
          {
            text: '⚔️ Войти в Обитель',
            url: 'https://t.me/DiceboundBot/dicebound?startapp=r_abcdefgh',
          },
        ],
      ],
    });
    expect(JSON.stringify(sent)).not.toContain('web_app');
    expect(JSON.stringify(sent)).not.toContain(TEST_TOKEN);
  });
  it('requires admin privileges for reliable membership verification', async () => {
    const { bot, rooms, sent } = setup(false);
    await bot.handleUpdate(messageUpdate());
    expect(rooms.ensureRoom).not.toHaveBeenCalled();
    expect(sent[0]?.text).toContain('администратором');
  });
  it('does not create a room from a private chat', async () => {
    const { bot, rooms } = setup();
    await bot.handleUpdate(
      messageUpdate({ chat: { id: 42, type: 'private', first_name: 'Alice' } }),
    );
    expect(rooms.ensureRoom).not.toHaveBeenCalled();
  });
  it('preserves room identity during group migration', async () => {
    const { bot, rooms } = setup();
    await bot.handleUpdate(
      messageUpdate({ text: undefined, entities: undefined, migrate_to_chat_id: -1009999999999 }),
    );
    expect(rooms.migrateChat).toHaveBeenCalledWith(ROOM.telegramChatId, -1009999999999n);
  });
  it('marks a removed bot as unable to send announcements', async () => {
    const { bot, rooms } = setup();
    await bot.handleUpdate({
      update_id: 2,
      my_chat_member: {
        date: 1,
        chat: { id: Number(ROOM.telegramChatId), type: 'supergroup', title: ROOM.title },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        old_chat_member: { status: 'member', user: bot.botInfo },
        new_chat_member: { status: 'kicked', until_date: 0, user: bot.botInfo },
      },
    });
    expect(rooms.setCanSendMessages).toHaveBeenCalledWith(ROOM.telegramChatId, false);
  });
  it('respects default group permissions after the bot is demoted', async () => {
    const { bot, rooms } = setup();
    await bot.handleUpdate({
      update_id: 3,
      my_chat_member: {
        date: 1,
        chat: { id: Number(ROOM.telegramChatId), type: 'supergroup', title: ROOM.title },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        old_chat_member: { status: 'left', user: bot.botInfo },
        new_chat_member: { status: 'member', user: bot.botInfo },
      },
    });
    expect(rooms.setCanSendMessages).toHaveBeenCalledWith(ROOM.telegramChatId, false);
  });
  it('suppresses sending if default group permissions cannot be verified', async () => {
    const { bot, rooms } = setup();
    bot.api.config.use(async (prev, method, payload, signal) => {
      if (method === 'getChat') throw new Error('Telegram unavailable');
      return prev(method, payload, signal);
    });
    await bot.handleUpdate({
      update_id: 4,
      my_chat_member: {
        date: 1,
        chat: { id: Number(ROOM.telegramChatId), type: 'supergroup', title: ROOM.title },
        from: { id: 42, is_bot: false, first_name: 'Alice' },
        old_chat_member: { status: 'left', user: bot.botInfo },
        new_chat_member: { status: 'member', user: bot.botInfo },
      },
    });
    expect(rooms.setCanSendMessages).toHaveBeenCalledWith(ROOM.telegramChatId, false);
  });
  it('treats restricted send permission separately from membership', () => {
    expect(
      canBotSendMessages({
        status: 'restricted',
        is_member: true,
        can_send_messages: false,
      } as ChatMember),
    ).toBe(false);
    expect(
      canBotSendMessages({
        status: 'restricted',
        is_member: true,
        can_send_messages: true,
      } as ChatMember),
    ).toBe(true);
    expect(canBotSendMessages({ status: 'member' } as ChatMember, false)).toBe(false);
  });
  it('validates deep-link components', () => {
    expect(() => miniAppUrl('bad/username', 'dicebound', ROOM.slug)).toThrow();
    expect(() => miniAppUrl('DiceboundBot', '../app', ROOM.slug)).toThrow();
    expect(() => miniAppUrl('DiceboundBot', 'dicebound', '../room')).toThrow();
  });
});
