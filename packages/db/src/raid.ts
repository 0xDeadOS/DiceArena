import {
  RAID_ROUNDS,
  SEAL_TARGET,
  facePlay,
  hornsLeft,
  parseCombatDie,
  raidExpiry,
  raidMaxHp,
  raidReward,
  raidRewardPool,
  raidRoundHp,
  raidShield,
  raidStrike,
  rankingWindowStart,
  RANKING_WINDOW_DAYS,
  requireRule,
  sealProgress,
} from '@dicebound/game-core';
import type {
  CombatDie,
  FaceAction,
  LeaderboardDTO,
  RaidAttackDTO,
  RaidDTO,
  RoomContext,
  TelegramIdentity,
} from '@dicebound/shared-types';
import type {
  PrismaClient,
  RaidAttack,
  RaidInstance,
  RoomMember,
} from './generated/prisma/client.js';
import { lockMember, memberCommand } from './transactions.js';
import { toDieDTO } from './profiles.js';
import type { Tx } from './transactions.js';
import { enqueueAnnouncement } from './events.js';
import { newSecretSeed, secretInt } from './random.js';

export type RaidCommand =
  | { type: 'CONTRIBUTE'; fragments: number; expectedRevision: number; confirmed: true }
  | { type: 'SUMMON'; expectedRevision: number; confirmed: true }
  | { type: 'ATTACK'; raidId: string; expectedRevision: number }
  | {
      type: 'DECIDE';
      raidId: string;
      attackId: string;
      expectedRevision: number;
      action: 'DIRECT' | 'SHIFT' | 'REROLL';
    };

export interface RaidRepository {
  current(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<RaidDTO>;
  leaderboard(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<LeaderboardDTO>;
  execute(
    room: RoomContext,
    identity: TelegramIdentity,
    command: RaidCommand,
    key: string,
    now: Date,
  ): Promise<RaidDTO>;
}

const BOSS_NAMES = [
  'Костяной патриарх',
  'Пепельный хор',
  'Хранитель печати',
  'Тень Обители',
] as const;
/** Один переброс на удар, как в обычном бою: всего два броска. */
const ROLLS_PER_ATTACK = 2;

export class PrismaRaidRepository implements RaidRepository {
  constructor(private readonly db: PrismaClient) {}

  current(room: RoomContext, identity: TelegramIdentity, now: Date) {
    return this.db.$transaction(async (tx) => {
      const member = await lockMember(tx, room, identity);
      await this.expire(tx, room, now);
      return this.read(tx, member, now);
    });
  }

  /**
   * Зачётный рейтинг семи дней: попадают только кубики, которыми выигрывали бой за окно.
   * Квалификация уже хранится на предмете (lastVictoryAt/lastVictoryPowerScore) и сбрасывается
   * любым крафтом, поэтому рейтинг нельзя надуть изменением артефакта задним числом.
   */
  async leaderboard(
    room: RoomContext,
    identity: TelegramIdentity,
    now: Date,
  ): Promise<LeaderboardDTO> {
    const windowStart = rankingWindowStart(now);
    const member = await this.db.roomMember.findFirst({
      where: { roomId: room.id, user: { telegramUserId: BigInt(identity.id) } },
      select: { id: true, equippedDieId: true },
    });
    requireRule(member, 'SESSION_REQUIRED', 'Сначала откройте игровую сессию.');
    const dice = await this.db.die.findMany({
      where: {
        owner: { roomId: room.id },
        lastVictoryAt: { gte: windowStart },
        lastVictoryPowerScore: { not: null },
      },
      include: {
        owner: {
          select: { id: true, equippedDieId: true, user: { select: { firstName: true } } },
        },
      },
      orderBy: [{ lastVictoryPowerScore: 'desc' }, { lastVictoryAt: 'desc' }],
      take: 20,
    });
    return {
      windowDays: RANKING_WINDOW_DAYS,
      windowStart: windowStart.toISOString(),
      entries: dice.map((die) => ({
        dieId: die.id,
        die: toDieDTO(die, die.owner.id === member.id ? die.owner.equippedDieId : null),
        ownerName: die.owner.user.firstName,
        lastVictoryAt: die.lastVictoryAt!.toISOString(),
        lastVictoryPowerScore: die.lastVictoryPowerScore!,
        qualified: true,
      })),
    };
  }

  execute(
    room: RoomContext,
    identity: TelegramIdentity,
    command: RaidCommand,
    key: string,
    now: Date,
  ) {
    return memberCommand(
      this.db,
      room,
      identity,
      'raid:v1',
      command,
      key,
      now,
      async (tx, member) => {
        await this.expire(tx, room, now);
        if (command.type === 'CONTRIBUTE') return this.contribute(tx, member, command, now);
        if (command.type === 'SUMMON') return this.summon(tx, member, command, now);
        if (command.type === 'ATTACK') return this.attack(tx, member, command, now);
        return this.decide(tx, member, command, now);
      },
    );
  }

  /** Просрочка определяется лениво: рейд без атак тоже обязан стать EXPIRED. */
  private async expire(tx: Tx, room: RoomContext, now: Date) {
    await tx.raidInstance.updateMany({
      where: { roomId: room.id, status: 'ACTIVE', expiresAt: { lte: now } },
      data: { status: 'EXPIRED', currentHp: 0 },
    });
  }

  private async contribute(
    tx: Tx,
    member: RoomMember,
    command: Extract<RaidCommand, { type: 'CONTRIBUTE' }>,
    now: Date,
  ) {
    requireRule(command.confirmed === true, 'CONFIRMATION_REQUIRED', 'Подтвердите вклад в печать.');
    const amount = command.fragments;
    requireRule(
      Number.isInteger(amount) && amount > 0 && amount <= member.sealFragments,
      'FRAGMENTS_MISSING',
      'Столько фрагментов печати у вас нет.',
    );
    const room = await tx.room.findUniqueOrThrow({ where: { id: member.roomId } });
    const altar = sealProgress(room.sealFragments + amount);
    const accepted = altar.fragments - room.sealFragments;
    requireRule(accepted > 0, 'ALTAR_FULL', 'Алтарь печати уже полон.');
    await tx.room.update({ where: { id: room.id }, data: { sealFragments: altar.fragments } });
    const updated = await tx.roomMember.update({
      where: { id: member.id },
      data: { sealFragments: { decrement: accepted } },
    });
    return this.read(tx, updated, now);
  }

  private async summon(
    tx: Tx,
    member: RoomMember,
    command: Extract<RaidCommand, { type: 'SUMMON' }>,
    now: Date,
  ) {
    requireRule(command.confirmed === true, 'CONFIRMATION_REQUIRED', 'Подтвердите призыв рейда.');
    const room = await tx.room.findUniqueOrThrow({
      where: { id: member.roomId },
      include: { _count: { select: { members: true } } },
    });
    requireRule(
      sealProgress(room.sealFragments).ready,
      'SEAL_INCOMPLETE',
      `Алтарь печати не собран: нужно ${SEAL_TARGET} фрагментов.`,
    );
    const active = await tx.raidInstance.findFirst({
      where: { roomId: room.id, status: 'ACTIVE' },
      select: { id: true },
    });
    requireRule(!active, 'RAID_ALREADY_ACTIVE', 'Рейд Обители уже призван.');
    const members = Math.max(1, room._count.members);
    const name = await tx.user.findUniqueOrThrow({ where: { id: member.userId } });
    const raid = await tx.raidInstance.create({
      data: {
        roomId: room.id,
        summonedById: member.id,
        bossName: BOSS_NAMES[members % BOSS_NAMES.length]!,
        maxHp: raidMaxHp(members),
        currentHp: raidRoundHp(members),
        shield: raidShield(1),
        phase: 1,
        status: 'ACTIVE',
        createdAt: now,
        expiresAt: raidExpiry(now),
      },
    });
    await tx.room.update({ where: { id: room.id }, data: { sealFragments: 0 } });
    await enqueueAnnouncement(tx, {
      id: room.id,
      eventType: 'RAID_SUMMONED',
      dedupKey: `raid:${raid.id}:summoned`,
      memberId: member.id,
      now,
      payload: {
        title: 'Печать сломана',
        text: `${name.firstName} призвал «${raid.bossName}». Рейд идёт 48 часов, три рога в сутки на участника.`,
        bossName: raid.bossName,
        maxHp: raid.maxHp,
        expiresAt: raid.expiresAt.toISOString(),
      },
    });
    return this.read(tx, member, now);
  }

  /** Рог тратится сразу: удар создаётся уже с сохранённым серверным броском. */
  private async attack(
    tx: Tx,
    member: RoomMember,
    command: Extract<RaidCommand, { type: 'ATTACK' }>,
    now: Date,
  ) {
    const raid = await this.lockRaid(tx, command.raidId, member.roomId, command.expectedRevision);
    requireRule(
      raid.status === 'ACTIVE' && raid.expiresAt > now,
      'RAID_CLOSED',
      'Рейд завершён или истёк.',
    );
    requireRule(member.equippedDieId, 'NO_EQUIPPED_DIE', 'Сначала экипируйте кубик в инвентаре.');
    const open = await tx.raidAttack.findFirst({
      where: { raidId: raid.id, memberId: member.id, state: { not: 'FINISHED' } },
      select: { id: true },
    });
    requireRule(!open, 'ATTACK_ALREADY_OPEN', 'Сначала завершите начатый удар.');
    const used = await tx.raidAttack.count({
      where: { raidId: raid.id, memberId: member.id, createdAt: { gte: startOfUtcDay(now) } },
    });
    requireRule(
      hornsLeft(used) > 0,
      'HORNS_SPENT',
      'Сегодня рога уже потрачены. Возвращайтесь завтра по UTC.',
    );
    const seed = newSecretSeed();
    await tx.raidAttack.create({
      data: {
        raidId: raid.id,
        memberId: member.id,
        attackSeed: seed,
        state: 'AWAITING_DECISION',
        rollsUsed: 1,
        currentRolledFace: secretInt(seed, 'raid-roll', 0, 6) + 1,
        round: raid.phase,
        createdAt: now,
      },
    });
    await tx.raidInstance.update({
      where: { id: raid.id },
      data: { revision: { increment: 1 } },
    });
    return this.read(tx, member, now);
  }

  private async decide(
    tx: Tx,
    member: RoomMember,
    command: Extract<RaidCommand, { type: 'DECIDE' }>,
    now: Date,
  ) {
    const raid = await this.lockRaid(tx, command.raidId, member.roomId, command.expectedRevision);
    requireRule(
      raid.status === 'ACTIVE' && raid.expiresAt > now,
      'RAID_CLOSED',
      'Рейд завершён или истёк.',
    );
    const found = await tx.raidAttack.findFirst({
      where: { id: command.attackId, raidId: raid.id, memberId: member.id },
    });
    requireRule(found, 'ATTACK_NOT_FOUND', 'Удар не найден в этом рейде.');
    requireRule(found.state !== 'FINISHED', 'ATTACK_FINISHED', 'Этот удар уже завершён.');
    const seed = found.attackSeed;
    requireRule(seed, 'ATTACK_BROKEN', 'Удар повреждён. Начните новый.');
    const rolled = found.currentRolledFace;
    requireRule(
      found.state === 'AWAITING_DECISION' && rolled !== null,
      'ROLL_REQUIRED',
      'Бросок ещё не сохранён.',
    );
    if (command.action === 'REROLL') {
      requireRule(found.rollsUsed < ROLLS_PER_ATTACK, 'NO_REROLLS', 'Переброс уже использован.');
      await tx.raidAttack.update({
        where: { id: found.id },
        data: {
          rollsUsed: found.rollsUsed + 1,
          currentRolledFace: secretInt(seed, 'raid-roll', found.rollsUsed, 6) + 1,
        },
      });
      await tx.raidInstance.update({
        where: { id: raid.id },
        data: { revision: { increment: 1 } },
      });
      return this.read(tx, member, now);
    }
    const loadout = parseCombatDie(
      await tx.die.findUniqueOrThrow({ where: { id: member.equippedDieId! } }),
    );
    const direct = facePlay(loadout, rolled!);
    const play = command.action === 'DIRECT' ? direct : shifted(direct);
    const strike = raidStrike(raid.phase, raid.currentHp, raid.shield, play.action, play.value);
    const defeated = strike.roundCleared && raid.phase >= RAID_ROUNDS;
    await tx.raidAttack.update({
      where: { id: found.id },
      data: {
        state: 'FINISHED',
        currentRolledFace: null,
        action: play.action,
        faceValue: play.value,
        damageDealt: strike.damage,
        finishedAt: now,
      },
    });
    await tx.raidInstance.update({
      where: { id: raid.id },
      data: {
        currentHp: defeated ? 0 : strike.roundCleared ? raidRoundHpFor(raid) : strike.roundHp,
        shield: defeated
          ? 0
          : strike.roundCleared
            ? raidShield(Math.min(RAID_ROUNDS, raid.phase + 1))
            : strike.shield,
        phase: defeated || !strike.roundCleared ? raid.phase : raid.phase + 1,
        status: defeated ? 'DEFEATED' : raid.status,
        defeatedAt: defeated ? now : null,
        revision: { increment: 1 },
      },
    });
    if (defeated) await this.reward(tx, raid, member.roomId, now);
    return this.read(tx, member, now);
  }

  private async reward(tx: Tx, raid: RaidInstance, roomId: string, now: Date) {
    const grouped = await tx.raidAttack.groupBy({
      by: ['memberId'],
      where: { raidId: raid.id, state: 'FINISHED' },
      _sum: { damageDealt: true },
    });
    const participants = grouped
      .map((row) => ({ memberId: row.memberId, damage: row._sum.damageDealt ?? 0 }))
      .filter((row) => row.damage > 0);
    if (participants.length === 0) return;
    const members = await tx.roomMember.count({ where: { roomId } });
    const pool = raidRewardPool(members);
    for (const entry of raidReward(participants, pool))
      await tx.roomMember.update({
        where: { id: entry.memberId },
        data: {
          gold: { increment: entry.gold },
          facetDust: { increment: entry.dust },
          inventoryRevision: { increment: 1 },
        },
      });
    const total = participants.reduce((sum, entry) => sum + entry.damage, 0);
    await enqueueAnnouncement(tx, {
      id: roomId,
      eventType: 'RAID_DEFEATED',
      dedupKey: `raid:${raid.id}:defeated`,
      now,
      payload: {
        title: 'Рейд побеждён',
        text: `Обитель сломила «${raid.bossName}»: ${participants.length} участников, ${total} урона. Награда разделена по доле урона.`,
        bossName: raid.bossName,
        totalDamage: total,
        participants: participants.length,
      },
    });
  }

  private async lockRaid(
    tx: Tx,
    raidId: string,
    roomId: string,
    expectedRevision: number,
  ): Promise<RaidInstance> {
    const found = await tx.raidInstance.findFirst({ where: { id: raidId, roomId } });
    requireRule(found, 'RAID_NOT_FOUND', 'Рейд не найден в этой Обители.');
    await tx.$queryRaw`SELECT id FROM "RaidInstance" WHERE id=${found.id}::uuid FOR UPDATE`;
    const raid = await tx.raidInstance.findUniqueOrThrow({ where: { id: found.id } });
    requireRule(
      raid.revision === expectedRevision,
      'STALE_RAID',
      'Рейд изменился. Обновите данные и ударьте заново.',
    );
    return raid;
  }

  private async read(tx: Tx, member: RoomMember, now: Date): Promise<RaidDTO> {
    const room = await tx.room.findUniqueOrThrow({ where: { id: member.roomId } });
    const altar = sealProgress(room.sealFragments);
    // Показываем активный рейд, а если его нет — последний завершённый как итог Обители.
    // Сортировка по статусу намеренно по возрастанию: в enum ACTIVE=1, DEFEATED=2, EXPIRED=3.
    const raid = await tx.raidInstance.findFirst({
      where: { roomId: member.roomId },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      include: {
        attacks: {
          where: { state: 'FINISHED' },
          include: { member: { select: { id: true, user: { select: { firstName: true } } } } },
        },
      },
    });
    const open = raid
      ? await tx.raidAttack.findFirst({
          where: { raidId: raid.id, memberId: member.id, state: { not: 'FINISHED' } },
        })
      : null;
    const usedToday = raid
      ? await tx.raidAttack.count({
          where: { raidId: raid.id, memberId: member.id, createdAt: { gte: startOfUtcDay(now) } },
        })
      : 0;
    const active = raid?.status === 'ACTIVE' && raid.expiresAt > now;
    const totals = new Map<string, { damage: number; attacks: number; firstName: string }>();
    for (const attack of raid?.attacks ?? []) {
      const entry = totals.get(attack.memberId) ?? {
        damage: 0,
        attacks: 0,
        firstName: attack.member.user.firstName,
      };
      entry.damage += attack.damageDealt;
      entry.attacks += 1;
      totals.set(attack.memberId, entry);
    }
    const contributions = [...totals.entries()]
      .map(([memberId, entry]) => ({ memberId, ...entry }))
      .sort((a, b) => b.damage - a.damage || a.firstName.localeCompare(b.firstName));
    const loadout = member.equippedDieId
      ? parseCombatDie(await tx.die.findUniqueOrThrow({ where: { id: member.equippedDieId } }))
      : null;
    return {
      altar: { ...altar, target: SEAL_TARGET },
      myFragments: member.sealFragments,
      hornsLeft: active ? hornsLeft(usedToday) : 0,
      raid: raid
        ? {
            id: raid.id,
            bossName: raid.bossName,
            status: raid.status,
            phase: raid.phase,
            rounds: Array.from({ length: RAID_ROUNDS }, (_, index) => ({
              round: index + 1,
              shield: raidShield(index + 1),
              cleared: raid.status === 'DEFEATED' || index + 1 < raid.phase,
            })),
            currentHp: raid.currentHp,
            roundHp: raidRoundHpFor(raid),
            shield: raid.shield,
            maxHp: raid.maxHp,
            revision: raid.revision,
            createdAt: raid.createdAt.toISOString(),
            expiresAt: raid.expiresAt.toISOString(),
            defeatedAt: raid.defeatedAt?.toISOString() ?? null,
            myDamage: totals.get(member.id)?.damage ?? 0,
            totalDamage: contributions.reduce((sum, entry) => sum + entry.damage, 0),
            contributions,
            attack: open ? attackDTO(open, loadout) : null,
          }
        : null,
      canContribute: permission(
        member.sealFragments > 0 && !altar.ready,
        member.sealFragments === 0
          ? 'Фрагменты печати даёт победа над боссом обычной экспедиции.'
          : 'Алтарь печати уже полон.',
      ),
      canSummon: permission(
        altar.ready && !active,
        !altar.ready ? `Нужно ${SEAL_TARGET} фрагментов в алтаре.` : 'Рейд Обители уже идёт.',
      ),
      canAttack: permission(
        active && hornsLeft(usedToday) > 0 && Boolean(loadout),
        !active
          ? 'Рейд не активен.'
          : hornsLeft(usedToday) === 0
            ? 'Сегодня рога уже потрачены.'
            : 'Сначала экипируйте кубик.',
      ),
    };
  }
}

function attackDTO(attack: RaidAttack, loadout: CombatDie | null): RaidAttackDTO {
  const face = attack.currentRolledFace;
  const direct = loadout && face !== null ? facePlay(loadout, face) : null;
  return {
    id: attack.id,
    round: attack.round,
    rollsUsed: attack.rollsUsed,
    rerollsLeft: Math.max(0, ROLLS_PER_ATTACK - attack.rollsUsed),
    focusCharges: 0,
    state: attack.state,
    currentRolledFace: face,
    options: direct
      ? {
          direct,
          shift: direct.action === 'STRIKE' || direct.action === 'GUARD' ? shifted(direct) : null,
          flip: null,
        }
      : null,
    action: (attack.action ?? null) as FaceAction | null,
    faceValue: attack.faceValue,
    damageDealt: attack.damageDealt,
  };
}

/** Стойка в рейде работает как в бою: половина эффективного значения и смена действия. */
function shifted(direct: ReturnType<typeof facePlay>) {
  requireRule(
    direct.action === 'STRIKE' || direct.action === 'GUARD',
    'STANCE_UNAVAILABLE',
    'Эту грань нельзя разыграть стойкой.',
  );
  return {
    ...direct,
    action: direct.action === 'GUARD' ? ('STRIKE' as const) : ('GUARD' as const),
    value: Math.ceil((direct.value * 50) / 100),
  };
}

const permission = (
  allowed: boolean,
  reason: string,
): { allowed: boolean; reason: string | null } => ({ allowed, reason: allowed ? null : reason });

/** Сутки UTC: рога восстанавливаются по календарному дню, а не по скользящим 24 часам. */
function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function raidRoundHpFor(raid: RaidInstance): number {
  return Math.max(1, Math.round(raid.maxHp / RAID_ROUNDS));
}
