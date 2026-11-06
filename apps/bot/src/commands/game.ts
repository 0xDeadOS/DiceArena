import { InlineKeyboard } from 'grammy';
import type { Context } from 'grammy';
import type { RoomRepository } from '@dicebound/db';
import { nanoid } from 'nanoid';

export function miniAppUrl(botUsername: string, appShortName: string, slug: string) {
  if (
    !/^[A-Za-z0-9_]{5,32}$/.test(botUsername) ||
    !/^[A-Za-z0-9_]{3,64}$/.test(appShortName) ||
    !/^r_[A-Za-z0-9_-]{8}$/.test(slug)
  ) {
    throw new Error('Invalid Mini App link configuration');
  }
  return `https://t.me/${botUsername}/${appShortName}?startapp=${slug}`;
}

export function gameCommand(rooms: RoomRepository, appShortName: string) {
  return async (ctx: Context) => {
    if (!ctx.chat || !['group', 'supergroup'].includes(ctx.chat.type)) {
      await ctx.reply(
        'Обитель принадлежит групповому чату. Добавьте меня в группу, назначьте администратором и отправьте /game.',
      );
      return;
    }
    // getChatMember for other users is only guaranteed when the bot is an admin.
    const me = await ctx.api.getChatMember(ctx.chat.id, ctx.me.id);
    if (me.status !== 'administrator' && me.status !== 'creator') {
      await ctx.reply(
        'Для безопасной проверки участников назначьте бота администратором, затем повторите /game. Права удаления сообщений или блокировки участников не нужны.',
      );
      return;
    }
    const title = 'title' in ctx.chat ? (ctx.chat.title ?? 'Обитель') : 'Обитель';
    let room;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        room = await rooms.ensureRoom(BigInt(ctx.chat.id), title, `r_${nanoid(8)}`);
        break;
      } catch (error) {
        // A random-slug collision is safe to retry; any other failure propagates.
        if (
          !(error && typeof error === 'object' && 'code' in error && error.code === 'P2002') ||
          attempt === 2
        )
          throw error;
      }
    }
    if (!room) throw new Error('Room creation failed');
    const url = miniAppUrl(ctx.me.username, appShortName, room.slug);
    await ctx.reply(
      '🎲 Ваша Обитель готова. Один чат — одна команда, отдельный герой и свой кубик.\n\nНачните с обучения у костра: тренировочный бой, учебная сфера и первый крафт. Затем откроются обычные экспедиции за бодрость — с золотом, пылью, сферами и новыми кубиками. Рейды Обители появятся следующим этапом.',
      {
        reply_markup: new InlineKeyboard().url('⚔️ Войти в Обитель', url),
      },
    );
  };
}
