import { SPHERE_TYPES } from '@dicebound/shared-types';
import type {
  CraftRequest,
  DismantleRequest,
  EquipRequest,
  InventoryDTO,
  InventoryResponse,
  InventoryResult,
  LockRequest,
  RoomContext,
  TelegramIdentity,
} from '@dicebound/shared-types';
import {
  craftDie,
  craftRejection,
  dismantleDust,
  dismantlePermission,
  isDestructiveCraft,
  parseCombatDie,
  POWER_SCORE_MODEL,
  requireRule,
} from '@dicebound/game-core';
import type { PrismaClient, RoomMember } from './generated/prisma/client.js';
import { json, lockMember, memberCommand } from './transactions.js';
import type { Tx } from './transactions.js';
import { readLockedHub, toDieDTO } from './profiles.js';
import { newSecretSeed, secretInt } from './random.js';
export type InventoryCommand =
  | ({ type: 'EQUIP' } & EquipRequest)
  | ({ type: 'LOCK' } & LockRequest)
  | ({ type: 'DISMANTLE' } & DismantleRequest)
  | ({ type: 'CRAFT' } & CraftRequest);
export interface InventoryRepository {
  current(room: RoomContext, identity: TelegramIdentity, now: Date): Promise<InventoryDTO>;
  execute(
    room: RoomContext,
    identity: TelegramIdentity,
    command: InventoryCommand,
    key: string,
    now: Date,
  ): Promise<InventoryResponse>;
}
export class PrismaInventoryRepository implements InventoryRepository {
  constructor(private readonly db: PrismaClient) {}
  current(room: RoomContext, identity: TelegramIdentity, now: Date) {
    return this.db.$transaction(async (tx) => {
      const member = await lockMember(tx, room, identity);
      return this.snapshot(tx, member, now);
    });
  }
  execute(
    room: RoomContext,
    identity: TelegramIdentity,
    command: InventoryCommand,
    key: string,
    now: Date,
  ) {
    return memberCommand(
      this.db,
      room,
      identity,
      'inventory:v1',
      command,
      key,
      now,
      async (tx, member) => {
        requireRule(
          command.expectedRevision === member.inventoryRevision,
          'STALE_INVENTORY',
          'Инвентарь изменился. Обновите данные и подтвердите действие заново.',
        );
        const found = await tx.die.findFirst({ where: { id: command.dieId, ownerId: member.id } });
        requireRule(found, 'DIE_NOT_FOUND', 'Кубик не найден в этой Обители.');
        await tx.$queryRaw`SELECT id FROM "Die" WHERE id=${found.id}::uuid FOR UPDATE`;
        const item = await tx.die.findUniqueOrThrow({ where: { id: found.id } });
        const before = toDieDTO(item, member.equippedDieId);
        let result: InventoryResult;
        switch (command.type) {
          case 'EQUIP':
            requireRule(!before.isEquipped, 'ALREADY_EQUIPPED', 'Этот кубик уже в руке.');
            requireRule(
              item.rarity !== 'UNIQUE',
              'UNSUPPORTED_DIE',
              'Уникальные кубики пока не поддерживаются в бою.',
            );
            parseCombatDie(item);
            await tx.roomMember.update({
              where: { id: member.id },
              data: { equippedDieId: item.id },
            });
            result = { type: 'EQUIP', dieId: item.id };
            break;
          case 'LOCK':
            requireRule(
              item.isLocked !== command.locked,
              'LOCK_UNCHANGED',
              'Состояние защиты уже изменилось.',
            );
            await tx.die.update({ where: { id: item.id }, data: { isLocked: command.locked } });
            result = { type: 'LOCK', dieId: item.id };
            break;
          case 'DISMANTLE': {
            requireRule(
              command.confirmed === true,
              'CONFIRMATION_REQUIRED',
              'Подтвердите распыление.',
            );
            const activeId = await this.activeDie(tx, member.id);
            const permission = dismantlePermission(before, activeId);
            requireRule(
              permission.allowed,
              'DISMANTLE_FORBIDDEN',
              permission.reason ?? 'Распыление недоступно.',
            );
            const dust = dismantleDust(item.rarity);
            await tx.die.delete({ where: { id: item.id } });
            await tx.roomMember.update({
              where: { id: member.id },
              data: { facetDust: { increment: dust } },
            });
            result = { type: 'DISMANTLE', dieId: item.id, dust };
            break;
          }
          case 'CRAFT': {
            requireRule(
              command.confirmed === true,
              'CONFIRMATION_REQUIRED',
              'Подтвердите расход сферы.',
            );
            const rejection = craftRejection(before, command.sphere);
            requireRule(
              !rejection,
              rejection?.code ?? 'CRAFT_UNAVAILABLE',
              rejection?.message ?? 'Крафт недоступен.',
            );
            const currency = await tx.userCurrency.findUnique({
              where: { ownerId_sphereType: { ownerId: member.id, sphereType: command.sphere } },
            });
            requireRule(
              currency && currency.amount > 0,
              'SPHERE_MISSING',
              'Нужной сферы нет в кошельке.',
            );
            let seed: string | undefined;
            let step = 0;
            const crafted = craftDie(before, command.sphere, (max) =>
              secretInt((seed ??= newSecretSeed()), 'craft', step++, max),
            );
            await tx.userCurrency.update({
              where: { id: currency.id },
              data: { amount: { decrement: 1 } },
            });
            const after = await tx.die.update({
              where: { id: item.id },
              data: {
                quality: crafted.quality,
                rarity: crafted.rarity,
                faces: json(crafted.faces),
                affixes: json(crafted.affixes),
                powerScore: crafted.powerScore,
                contentVersion: crafted.contentVersion,
                lastVictoryAt: null,
                lastVictoryPowerScore: null,
              },
            });
            result = {
              type: 'CRAFT',
              dieId: item.id,
              sphere: command.sphere,
              before,
              after: toDieDTO(after, member.equippedDieId),
            };
            break;
          }
        }
        const updated = await tx.roomMember.update({
          where: { id: member.id },
          data: { inventoryRevision: { increment: 1 } },
        });
        return { inventory: await this.snapshot(tx, updated, now), result };
      },
    );
  }
  private async activeDie(tx: Tx, memberId: string): Promise<string | null> {
    const active = await tx.mapRun.findFirst({
      where: { ownerId: memberId, status: 'IN_PROGRESS' },
      select: { dieSnapshot: true },
    });
    if (!active) return null;
    // No playable runs predate snapshots; fail closed rather than allow legacy gear destruction.
    requireRule(
      active.dieSnapshot !== null,
      'UNSUPPORTED_RUN',
      'Сначала завершите поход старой версии.',
    );
    return parseCombatDie(active.dieSnapshot).id;
  }
  private async snapshot(tx: Tx, member: RoomMember, now: Date): Promise<InventoryDTO> {
    const hub = await readLockedHub(tx, member.id, now);
    const activeRunDieId = await this.activeDie(tx, member.id);
    return {
      hub,
      activeRunDieId,
      powerScoreModel: POWER_SCORE_MODEL,
      policies: hub.inventory.dice.map((die) => ({
        dieId: die.id,
        equip: {
          allowed: !die.isEquipped && die.rarity !== 'UNIQUE',
          reason: die.isEquipped
            ? 'Уже в руке.'
            : die.rarity === 'UNIQUE'
              ? 'Уникальные кубики пока не поддерживаются.'
              : null,
        },
        dismantle: { ...dismantlePermission(die, activeRunDieId), dust: dismantleDust(die.rarity) },
        craft: SPHERE_TYPES.map((sphere) => {
          const rejection = craftRejection(die, sphere);
          const hasSphere = (hub.inventory.spheres.find((s) => s.type === sphere)?.amount ?? 0) > 0;
          const reason = rejection?.message ?? (!hasSphere ? 'Нет сферы в кошельке.' : null);
          return {
            sphere,
            cost: 1,
            destructive: isDestructiveCraft(die, sphere),
            allowed: reason === null,
            reason,
          };
        }),
      })),
    };
  }
}
