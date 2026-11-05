import { SPHERE_TYPES } from '@dicebound/shared-types';
import type {
  CraftRequest,
  MasterFacetRequest,
  TutorialRequest,
  ClaimDropRequest,
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
  INVENTORY_CAPACITY,
  craftRejection,
  dismantleDust,
  dismantlePermission,
  isDestructiveCraft,
  masterFacetCost,
  masterFacetDie,
  masterFacetRejection,
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
  | ({ type: 'TUTORIAL_REWARD' } & TutorialRequest)
  | ({ type: 'TUTORIAL_COMPLETE' } & TutorialRequest)
  | ({ type: 'CLAIM_DROP' } & ClaimDropRequest)
  | ({ type: 'EQUIP' } & EquipRequest)
  | ({ type: 'LOCK' } & LockRequest)
  | ({ type: 'DISMANTLE' } & DismantleRequest)
  | ({ type: 'CRAFT' } & CraftRequest)
  | ({ type: 'MASTER_FACET' } & MasterFacetRequest);
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
        if (
          command.type === 'TUTORIAL_REWARD' ||
          command.type === 'TUTORIAL_COMPLETE' ||
          command.type === 'CLAIM_DROP'
        ) {
          const result = await this.progressCommand(tx, member, command);
          const updated = await tx.roomMember.update({
            where: { id: member.id },
            data: { inventoryRevision: { increment: 1 } },
          });
          return { inventory: await this.snapshot(tx, updated, now), result };
        }
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
          case 'MASTER_FACET': {
            requireRule(
              command.confirmed === true,
              'CONFIRMATION_REQUIRED',
              'Подтвердите огранку грани.',
            );
            const rejection = masterFacetRejection(before, command.face, command.action);
            requireRule(
              !rejection,
              rejection?.code ?? 'MASTER_FACET_UNAVAILABLE',
              rejection?.message ?? 'Огранка недоступна.',
            );
            const cost = masterFacetCost(item.ilvl);
            requireRule(
              member.facetDust >= cost,
              'DUST_MISSING',
              `Нужно ${cost} пыли граней, сейчас ${member.facetDust}.`,
            );
            let facetSeed: string | undefined;
            let facetStep = 0;
            const faceted = masterFacetDie(before, command.face, command.action, (max) =>
              secretInt((facetSeed ??= newSecretSeed()), 'facet', facetStep++, max),
            );
            await tx.roomMember.update({
              where: { id: member.id },
              data: { facetDust: { decrement: cost } },
            });
            const after = await tx.die.update({
              where: { id: item.id },
              data: {
                faces: json(faceted.faces),
                powerScore: faceted.powerScore,
                contentVersion: faceted.contentVersion,
                masterCrafted: true,
                lastVictoryAt: null,
                lastVictoryPowerScore: null,
              },
            });
            result = {
              type: 'MASTER_FACET',
              dieId: item.id,
              face: command.face,
              action: command.action,
              dust: cost,
              before,
              after: toDieDTO(after, member.equippedDieId),
            };
            break;
          }
        }
        const updated = await tx.roomMember.update({
          where: { id: member.id },
          data: {
            inventoryRevision: { increment: 1 },
            tutorialCrafted: command.type === 'CRAFT' ? true : undefined,
          },
        });
        return { inventory: await this.snapshot(tx, updated, now), result };
      },
    );
  }
  private async progressCommand(
    tx: Tx,
    member: RoomMember,
    command: Extract<
      InventoryCommand,
      { type: 'CLAIM_DROP' | 'TUTORIAL_REWARD' | 'TUTORIAL_COMPLETE' }
    >,
  ): Promise<InventoryResult> {
    requireRule(command.confirmed === true, 'CONFIRMATION_REQUIRED', 'Подтвердите действие.');
    if (command.type === 'TUTORIAL_REWARD') {
      requireRule(
        member.tutorialTrainingWon,
        'TRAINING_REQUIRED',
        'Сначала победите в тренировочных катакомбах.',
      );
      requireRule(
        !member.tutorialRewardClaimed,
        'REWARD_ALREADY_CLAIMED',
        'Учебная сфера уже получена.',
      );
      await tx.userCurrency.upsert({
        where: { ownerId_sphereType: { ownerId: member.id, sphereType: 'CASTING' } },
        create: { ownerId: member.id, sphereType: 'CASTING', amount: 1 },
        update: { amount: { increment: 1 } },
      });
      await tx.roomMember.update({
        where: { id: member.id },
        data: { tutorialRewardClaimed: true },
      });
      return { type: 'TUTORIAL_REWARD', sphere: 'CASTING', amount: 1 };
    }
    if (command.type === 'TUTORIAL_COMPLETE') {
      requireRule(!member.tutorialDone, 'TUTORIAL_ALREADY_COMPLETE', 'Обучение уже завершено.');
      requireRule(
        member.tutorialTrainingWon && member.tutorialCrafted && member.tutorialRewardClaimed,
        'TUTORIAL_INCOMPLETE',
        'Победите в тренировке, заберите учебную сферу и выполните крафт.',
      );
      await tx.roomMember.update({ where: { id: member.id }, data: { tutorialDone: true } });
      return { type: 'TUTORIAL_COMPLETE' };
    }
    const drop = await tx.pendingDrop.findFirst({
      where: { id: command.dropId, ownerId: member.id },
    });
    requireRule(drop, 'DROP_NOT_FOUND', 'Трофей не найден или уже разобран.');
    const item = parseCombatDie(drop.dieData);
    requireRule(item.id === drop.id, 'INVALID_DROP', 'Трофей повреждён.');
    let result: InventoryResult;
    if (command.action === 'TAKE') {
      requireRule(
        (await tx.die.count({ where: { ownerId: member.id } })) < INVENTORY_CAPACITY,
        'INVENTORY_FULL',
        'В сумке нет свободного слота. Трофей сохранён.',
      );
      await tx.die.create({
        data: {
          id: item.id,
          ownerId: member.id,
          baseType: item.baseType,
          ilvl: item.ilvl,
          quality: item.quality,
          rarity: item.rarity,
          faces: json(item.faces),
          affixes: json(item.affixes),
          powerScore: item.powerScore,
          contentVersion: item.contentVersion ?? 0,
        },
      });
      result = { type: 'CLAIM_DROP', dieId: item.id };
    } else {
      requireRule(command.action === 'DUST', 'INVALID_CLAIM', 'Неизвестное действие с трофеем.');
      const dust = dismantleDust(item.rarity);
      await tx.roomMember.update({
        where: { id: member.id },
        data: { facetDust: { increment: dust } },
      });
      result = { type: 'SALVAGE_DROP', dieId: item.id, dust };
    }
    await tx.pendingDrop.delete({ where: { id: drop.id } });
    return result;
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
        masterFacet: (() => {
          // Face 1 / STRIKE is always a legal choice, so only die-level blocks can surface here.
          const rejection = masterFacetRejection(die, 1, 'STRIKE');
          const cost = masterFacetCost(die.ilvl);
          const reason =
            rejection?.message ??
            (hub.player.facetDust < cost ? `Нужно ${cost} пыли граней.` : null);
          return { allowed: reason === null, reason, cost };
        })(),
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
