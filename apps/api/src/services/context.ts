import type { ProfileRepository } from '@dicebound/db';
import type { VerifiedLaunch } from '../auth/init-data.js';
import type { MembershipChecker } from '../auth/membership.js';
import { AppError } from '../errors.js';

export async function resolveRoom(
  launch: VerifiedLaunch,
  profiles: ProfileRepository,
  membership: MembershipChecker,
) {
  const room = await profiles.findRoom(launch.roomSlug);
  if (!room)
    throw new AppError(
      404,
      'ROOM_NOT_FOUND',
      'Обитель не найдена. Получите новую ссылку через /game.',
    );
  await membership.assertMember(room.telegramChatId, launch.user.id);
  return room;
}
