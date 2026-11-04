import {
  calculatePowerScore,
  INVENTORY_CAPACITY,
  MAX_VIGOR,
  refreshVigor,
  STARTING_GOLD,
  STARTING_SPHERES,
  STARTING_VIGOR,
  starterFaces,
} from '@dicebound/game-core';
import { FACE_ACTIONS, SPHERE_TYPES } from '@dicebound/shared-types';
import type {
  DieAffix,
  DieFace,
  FaceAction,
  HubDTO,
  RoomContext,
  TelegramIdentity,
} from '@dicebound/shared-types';
import type { Prisma, PrismaClient } from './generated/prisma/client.js';

export interface ProfileRepository {
  findRoom(slug: string): Promise<RoomContext | null>;
  openSession(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<HubDTO>;
  loadHub(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<HubDTO | null>;
  isReady(): Promise<boolean>;
}

export class PrismaProfileRepository implements ProfileRepository {
  constructor(private readonly db: PrismaClient) {}

  findRoom(slug: string) {
    return this.db.room.findUnique({
      where: { slug },
      select: { id: true, slug: true, title: true, telegramChatId: true },
    });
  }

  async isReady() {
    await this.db.$queryRaw`SELECT 1`;
    return true;
  }

  async openSession(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<HubDTO> {
    return this.db.$transaction(async (tx) => {
      // Serializes first registration even before a RoomMember row exists.
      // It is transaction-scoped and released on rollback or connection loss.
      const lockKey = `${room.id}:${identity.id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      const user = await tx.user.upsert({
        where: { telegramUserId: BigInt(identity.id) },
        create: {
          telegramUserId: BigInt(identity.id),
          firstName: identity.firstName,
          username: identity.username,
        },
        update: { firstName: identity.firstName, username: identity.username },
      });
      let member = await tx.roomMember.findUnique({
        where: { roomId_userId: { roomId: room.id, userId: user.id } },
      });
      if (!member) {
        member = await tx.roomMember.create({
          data: {
            roomId: room.id,
            userId: user.id,
            gold: STARTING_GOLD,
            storedVigor: STARTING_VIGOR,
            vigorUpdatedAt: now,
          },
        });
        const faces = starterFaces();
        const die = await tx.die.create({
          data: {
            ownerId: member.id,
            baseType: 'BONE',
            isStarter: true,
            faces: faces.map((face) => ({ ...face })),
            affixes: [],
            powerScore: calculatePowerScore(faces, 0),
          },
        });
        const ownerId = member.id;
        await tx.userCurrency.createMany({
          data: SPHERE_TYPES.map((type) => ({
            ownerId,
            sphereType: type,
            amount: STARTING_SPHERES[type],
          })),
        });
        await tx.roomMember.update({ where: { id: member.id }, data: { equippedDieId: die.id } });
      }
      return this.readLockedHub(tx, member.id, now);
    });
  }

  async loadHub(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<HubDTO | null> {
    return this.db.$transaction(async (tx) => {
      const member = await tx.roomMember.findFirst({
        where: { roomId: room.id, user: { telegramUserId: BigInt(identity.id) } },
        select: { id: true },
      });
      return member ? this.readLockedHub(tx, member.id, now) : null;
    });
  }

  private async readLockedHub(
    tx: Prisma.TransactionClient,
    memberId: string,
    now: Date,
  ): Promise<HubDTO> {
    await tx.$queryRaw`SELECT id FROM "RoomMember" WHERE id = ${memberId}::uuid FOR UPDATE`;
    const member = await tx.roomMember.findUniqueOrThrow({
      where: { id: memberId },
      include: {
        user: true,
        dice: { orderBy: { createdAt: 'asc' } },
        currencies: true,
        room: {
          include: {
            _count: { select: { members: true } },
            raidInstances: {
              where: { status: 'ACTIVE', expiresAt: { gt: now } },
              orderBy: { createdAt: 'desc' },
              take: 1,
              select: { id: true, bossName: true, currentHp: true, maxHp: true, expiresAt: true },
            },
          },
        },
        mapRuns: {
          where: { status: 'IN_PROGRESS' },
          take: 1,
          select: {
            id: true,
            currentNodeId: true,
            playerHp: true,
            playerMaxHp: true,
            hasVigorBoost: true,
          },
        },
      },
    });
    const vigor = refreshVigor(member.storedVigor, member.vigorUpdatedAt, now);
    if (vigor.updatedAt.getTime() !== member.vigorUpdatedAt.getTime()) {
      await tx.roomMember.update({
        where: { id: memberId },
        data: { storedVigor: vigor.current, vigorUpdatedAt: vigor.updatedAt },
      });
    }
    const raid = member.room.raidInstances[0];
    // Explicit projection: no ORM record is returned directly to the client.
    return {
      room: {
        id: member.room.id,
        slug: member.room.slug,
        title: member.room.title,
        memberCount: member.room._count.members,
        sealFragments: member.room.sealFragments,
      },
      player: {
        id: member.id,
        firstName: member.user.firstName,
        username: member.user.username,
        gold: member.gold,
        sealFragments: member.sealFragments,
        equippedDieId: member.equippedDieId,
        tutorialDone: member.tutorialDone,
        vigor: {
          current: vigor.current,
          maximum: MAX_VIGOR,
          nextRestoreAt: vigor.nextRestoreAt.toISOString(),
        },
      },
      inventory: {
        capacity: INVENTORY_CAPACITY,
        dice: member.dice.map((die) => ({
          id: die.id,
          baseType: die.baseType,
          ilvl: die.ilvl,
          quality: die.quality,
          rarity: die.rarity,
          faces: parseFaces(die.faces),
          affixes: parseAffixes(die.affixes),
          powerScore: die.powerScore,
          isStarter: die.isStarter,
          isLocked: die.isLocked,
          isEquipped: member.equippedDieId === die.id,
          masterCrafted: die.masterCrafted,
        })),
        spheres: SPHERE_TYPES.map((type) => ({
          type,
          amount: member.currencies.find((currency) => currency.sphereType === type)?.amount ?? 0,
        })),
      },
      activeRun: member.mapRuns[0] ?? null,
      raid: raid ? { ...raid, expiresAt: raid.expiresAt.toISOString() } : null,
    };
  }
}

function isObject(value: Prisma.JsonValue): value is Prisma.JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseFaces(value: Prisma.JsonValue): DieFace[] {
  if (!Array.isArray(value) || value.length !== 6) throw new Error('Invalid stored die faces');
  const faces = value.map((face) => {
    if (
      !isObject(face) ||
      typeof face.face !== 'number' ||
      !Number.isInteger(face.face) ||
      face.face < 1 ||
      face.face > 6 ||
      typeof face.value !== 'number' ||
      !Number.isInteger(face.value) ||
      face.value < 0 ||
      typeof face.action !== 'string' ||
      !FACE_ACTIONS.includes(face.action as FaceAction)
    ) {
      throw new Error('Invalid stored die face');
    }
    return { face: face.face, action: face.action as FaceAction, value: face.value };
  });
  if (new Set(faces.map((face) => face.face)).size !== 6)
    throw new Error('Duplicate stored die face');
  return faces;
}

function parseAffixes(value: Prisma.JsonValue): DieAffix[] {
  if (!Array.isArray(value) || value.length > 4) throw new Error('Invalid stored affixes');
  return value.map((affix) => {
    if (
      !isObject(affix) ||
      typeof affix.id !== 'string' ||
      (affix.kind !== 'PREFIX' && affix.kind !== 'SUFFIX') ||
      (affix.tier !== 1 && affix.tier !== 2 && affix.tier !== 3) ||
      typeof affix.value !== 'number' ||
      !Number.isFinite(affix.value)
    )
      throw new Error('Invalid stored affix');
    return { id: affix.id, kind: affix.kind, tier: affix.tier, value: affix.value };
  });
}
