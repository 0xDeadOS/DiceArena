import { Bot, InlineKeyboard } from 'grammy';
import type { ChatMember } from 'grammy/types';
import type { RoomRepository } from '@dicebound/db';
import { gameCommand } from './commands/game.js';

export function canBotSendMessages(member: ChatMember, defaultCanSendMessages = true): boolean {
  if (member.status === 'left' || member.status === 'kicked') return false;
  if (member.status === 'restricted') return member.is_member && member.can_send_messages;
  if (member.status === 'member') return defaultCanSendMessages;
  return true;
}

export function buildBot(token: string, appShortName: string, rooms: RoomRepository) {
  const bot = new Bot(token, { client: { timeoutSeconds: 10 } });
  bot.command('game', gameCommand(rooms, appShortName));
  bot.command('start', async (ctx) => {
    const group = ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
    await ctx.reply(
      group
        ? '🎲 Dicebound: Chat Raiders. Ваша компания — отдельная Обитель. Назначьте бота администратором и отправьте /game.'
        : '🎲 Добро пожаловать в Dicebound: Chat Raiders! Добавьте бота в дружеский чат, назначьте администратором и отправьте /game. В каждом чате у вас отдельный герой.\n\nДоступны обучение, тренировочные катакомбы, Мастерская сфер и обычные экспедиции с добычей. Рейды Обители уже доступны: собирайте фрагменты печати и призывайте общего босса.',
      group
        ? {}
        : {
            reply_markup: new InlineKeyboard().url(
              'Добавить в чат',
              `https://t.me/${ctx.me.username}?startgroup=true`,
            ),
          },
    );
  });
  bot.command('help', async (ctx) => {
    await ctx.reply(
      '🎲 Dicebound: Chat Raiders\n\n/game — открыть Обитель этого чата\n/start — как начать\n/help — эта памятка\n\nВ каждом чате — отдельный герой, один активный кубик и кошелёк сфер. Старт: 150 золота, 3 сферы Отливки, 2 Закалки и 1 Гранения.\n\nСейчас доступны: обучение из четырёх шагов, бесплатные тренировочные катакомбы, Мастерская шести сфер, инвентарь на 12 слотов и обычные экспедиции за бодрость с выпадением кубиков и сфер. Рейды Обители: 15 фрагментов печати в алтарь, призыв босса на 48 часов, три рога в сутки, награда по доле урона. При проблемах со входом проверьте права администратора у бота и получите новую ссылку /game. По вопросам тестовой версии обратитесь к владельцу бота.',
    );
  });
  bot.on('message:migrate_to_chat_id', async (ctx) => {
    await rooms.migrateChat(BigInt(ctx.chat.id), BigInt(ctx.message.migrate_to_chat_id));
  });
  bot.on('message:migrate_from_chat_id', async (ctx) => {
    await rooms.migrateChat(BigInt(ctx.message.migrate_from_chat_id), BigInt(ctx.chat.id));
  });
  bot.on('my_chat_member', async (ctx) => {
    const member = ctx.myChatMember.new_chat_member;
    let defaultCanSendMessages = true;
    if (member.status === 'member') {
      try {
        const chat = await ctx.api.getChat(ctx.chat.id);
        defaultCanSendMessages =
          'permissions' in chat ? chat.permissions?.can_send_messages !== false : true;
      } catch {
        // If default group permissions cannot be verified, suppress future sends.
        defaultCanSendMessages = false;
      }
    }
    await rooms.setCanSendMessages(
      BigInt(ctx.chat.id),
      canBotSendMessages(member, defaultCanSendMessages),
    );
  });
  bot.catch((error) => {
    // Do not log update payloads, bot tokens or raw HTTP error URLs.
    console.error({
      event: 'BOT_UPDATE_FAILED',
      updateId: error.ctx.update.update_id,
      errorName: error.error instanceof Error ? error.error.name : 'Unknown',
    });
  });
  return bot;
}
