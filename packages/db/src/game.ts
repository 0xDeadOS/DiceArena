import { randomUUID } from 'node:crypto';
import {
  addLoot,
  addExpeditionLoot,
  emptyExpeditionLoot,
  expeditionLootSchema,
  expeditionMap,
  expeditionReward,
  expeditionScale,
  EXPEDITION_COST,
  settleExpeditionLoot,
  refreshVigor,
  combatLogSchema,
  combatOptions,
  combatStats,
  decideCombat,
  effectsSchema,
  ENEMIES,
  GameRuleError,
  intentSchema,
  lootSchema,
  mapSchema,
  newCombat,
  parseCombatDie,
  requireRule,
  rollCombat,
  settleLoot,
  trainingMap,
  trainingReward,
} from '@dicebound/game-core';
import { ENEMY_TYPES } from '@dicebound/shared-types';
import type {
  BattleDecisionRequest,
  ExpeditionStartRequest,
  RunLootDTO,
  MapNodeDTO,
  BattleRollRequest,
  CombatState,
  EnemyType,
  MapStepRequest,
  RoomContext,
  RunDTO,
  RunMutation,
  TelegramIdentity,
} from '@dicebound/shared-types';
import type { Prisma } from './generated/prisma/client.js';
import type { PrismaClient } from './generated/prisma/client.js';
import type { Battle, MapRun, RoomMember } from './generated/prisma/client.js';
import { toDropDTO } from './profiles.js';
import { battleFace, newSecretSeed, secretInt } from './random.js';
import { json, lockMember, memberCommand } from './transactions.js';
import type { Tx } from './transactions.js';

export type GameCommand =
  | { type: 'START' }
  | ({ type: 'EXPEDITION' } & ExpeditionStartRequest)
  | ({ type: 'STEP' } & MapStepRequest)
  | ({ type: 'ROLL' } & BattleRollRequest)
  | ({ type: 'DECISION' } & BattleDecisionRequest)
  | ({ type: 'RETREAT' } & RunMutation);
export interface GameRepository {
  current(room: RoomContext, identity: TelegramIdentity): Promise<RunDTO | null>;
  execute(
    room: RoomContext,
    identity: TelegramIdentity,
    command: GameCommand,
    key: string,
    now: Date,
  ): Promise<RunDTO>;
}
export class PrismaGameRepository implements GameRepository {
  constructor(private readonly db: PrismaClient) {}

  async current(room: RoomContext, identity: TelegramIdentity): Promise<RunDTO | null> {
    return this.db.$transaction(async (tx) => {
      const member = await lockMember(tx, room, identity);
      const active = await tx.mapRun.findFirst({
        where: { ownerId: member.id, status: 'IN_PROGRESS' },
      });
      const run =
        active ??
        (await tx.mapRun.findFirst({
          where: { ownerId: member.id },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        }));
      return run ? this.snapshot(tx, run) : null;
    });
  }

  async execute(
    room: RoomContext,
    identity: TelegramIdentity,
    command: GameCommand,
    key: string,
    now: Date,
  ): Promise<RunDTO> {
    return memberCommand(
      this.db,
      room,
      identity,
      'game:v1',
      command,
      key,
      now,
      async (tx, member) => {
        let run: MapRun;
        if (command.type === 'START' || command.type === 'EXPEDITION')
          run = await this.start(tx, member, command.type === 'EXPEDITION' ? command : null, now);
        else {
          const owned = await tx.mapRun.findFirst({
            where: { id: command.runId, ownerId: member.id },
          });
          requireRule(owned, 'RUN_NOT_FOUND', 'Поход не найден в этой Обители.');
          await tx.$queryRaw`SELECT id FROM "MapRun" WHERE id=${owned.id}::uuid FOR UPDATE`;
          run = await tx.mapRun.findUniqueOrThrow({ where: { id: owned.id } });
          requireRule(run.status === 'IN_PROGRESS', 'RUN_FINISHED', 'Поход уже завершён.');
          requireRule(
            run.revision === command.expectedRevision,
            'STALE_STATE',
            'Состояние изменилось на другом устройстве. Обновите поход.',
          );
          if (command.type === 'STEP') run = await this.step(tx, run, command.nodeId);
          else if (command.type === 'RETREAT') {
            const active = await tx.battle.findFirst({
              where: { runId: run.id, state: { not: 'FINISHED' } },
            });
            if (active) {
              await tx.$queryRaw`SELECT id FROM "Battle" WHERE id=${active.id}::uuid FOR UPDATE`;
              const log = combatLogSchema.parse(active.log);
              await tx.battle.update({
                where: { id: active.id },
                data: {
                  state: 'FINISHED',
                  outcome: 'DEFEAT',
                  currentRolledFace: null,
                  log: json(
                    [...log, { turn: active.turnNumber, message: 'Отступление в Обитель.' }].slice(
                      -20,
                    ),
                  ),
                },
              });
            }
            run = await tx.mapRun.update({
              where: { id: run.id },
              data: { revision: { increment: 1 } },
            });
            run = await this.settle(tx, member, run, 'DEFEAT', now);
          } else run = await this.battleAction(tx, member, run, command, now);
        }
        return this.snapshot(tx, run);
      },
    );
  }

  private async start(
    tx: Tx,
    member: RoomMember,
    expedition: ExpeditionStartRequest | null,
    now: Date,
  ): Promise<MapRun> {
    requireRule(
      !(await tx.mapRun.findFirst({
        where: { ownerId: member.id, status: 'IN_PROGRESS' },
        select: { id: true },
      })),
      'ACTIVE_RUN_EXISTS',
      'Сначала завершите текущий поход.',
    );
    if (expedition) {
      requireRule(
        expedition.confirmed === true,
        'CONFIRMATION_REQUIRED',
        'Подтвердите расход бодрости.',
      );
      requireRule(
        expedition.expectedInventoryRevision === member.inventoryRevision,
        'STALE_INVENTORY',
        'Ресурсы изменились. Обновите данные и подтвердите поход заново.',
      );
      requireRule(member.tutorialDone, 'TUTORIAL_REQUIRED', 'Сначала завершите обучение у костра.');
      requireRule(
        Number.isInteger(expedition.level) &&
          expedition.level >= 1 &&
          expedition.level <= Math.min(50, member.highestExpeditionLevel + 1),
        'LEVEL_LOCKED',
        'Этот уровень экспедиции ещё не открыт.',
      );
      requireRule(
        (await tx.pendingDrop.count({ where: { ownerId: member.id } })) === 0,
        'UNCLAIMED_DROPS',
        'Сначала разберите трофеи прошлого похода в инвентаре.',
      );
      const vigor = refreshVigor(member.storedVigor, member.vigorUpdatedAt, now);
      requireRule(
        vigor.current >= EXPEDITION_COST,
        'NO_VIGOR',
        'Недостаточно бодрости. Тренировка остаётся бесплатной.',
      );
      await tx.roomMember.update({
        where: { id: member.id },
        data: {
          storedVigor: vigor.current - EXPEDITION_COST,
          vigorUpdatedAt: vigor.updatedAt,
          inventoryRevision: { increment: 1 },
        },
      });
    }
    const item = member.equippedDieId
      ? await tx.die.findFirst({ where: { id: member.equippedDieId, ownerId: member.id } })
      : null;
    requireRule(item, 'NO_EQUIPPED_DIE', 'Сначала экипируйте кубик.');
    const die = parseCombatDie(item);
    const seed = newSecretSeed();
    let step = 0;
    const nodes = (expedition ? expeditionMap : trainingMap)((max) =>
      secretInt(seed, 'map', step++, max),
    );
    const hp = combatStats(die).maxHp;
    return tx.mapRun.create({
      data: {
        ownerId: member.id,
        seed,
        hasVigorBoost: !!expedition,
        mode: expedition ? 'EXPEDITION' : 'TRAINING',
        level: expedition?.level ?? 0,
        enemyScale: expedition ? expeditionScale(expedition.level) : 600,
        dagMapData: json(nodes),
        visitedNodeIds: ['start'],
        dieSnapshot: json(die),
        playerHp: hp,
        playerMaxHp: hp,
        accumulatedLoot: expedition ? json(emptyExpeditionLoot()) : { gold: 0, dust: 0 },
      },
    });
  }

  private async step(tx: Tx, run: MapRun, nodeId: string): Promise<MapRun> {
    requireRule(
      !(await tx.battle.findFirst({
        where: { runId: run.id, state: { not: 'FINISHED' } },
        select: { id: true },
      })),
      'BATTLE_IN_PROGRESS',
      'Сначала завершите бой.',
    );
    const nodes = mapSchema.parse(run.dagMapData);
    const current = nodes.find((n) => n.id === run.currentNodeId);
    const next = nodes.find((n) => n.id === nodeId);
    requireRule(
      next && current?.next.includes(next.id),
      'NODE_NOT_REACHABLE',
      'Можно выбрать только соседний узел следующего уровня.',
    );
    const visited = readVisited(run.visitedNodeIds);
    requireRule(!visited.includes(next.id), 'NODE_ALREADY_VISITED', 'Этот узел уже пройден.');
    let hp = run.playerHp;
    let loot = this.readLoot(run, run.accumulatedLoot);
    if (next.type === 'CHEST') loot = this.collectLoot(run, next);
    if (next.type === 'CAMP')
      hp = Math.min(run.playerMaxHp, hp + Math.ceil(run.playerMaxHp * 0.35));
    if (['BATTLE', 'ELITE', 'BOSS'].includes(next.type)) {
      const die = parseCombatDie(run.dieSnapshot);
      const pool: EnemyType[] =
        next.type === 'BOSS'
          ? ['BONE_KING']
          : next.type === 'ELITE'
            ? ['STONE_GUARD', 'BLOOD_PRIEST']
            : ['SLIME', 'SPEARMAN', 'PLAGUE_RAT'];
      const type =
        next.depth === 1 ? 'SLIME' : pool[secretInt(run.seed, `enemy:${next.id}`, 0, pool.length)]!;
      const state = newCombat(type, die, hp, run.playerMaxHp, run.enemyScale);
      await tx.battle.create({
        data: { runId: run.id, nodeId: next.id, battleSeed: newSecretSeed(), ...battleData(state) },
      });
    }
    return tx.mapRun.update({
      where: { id: run.id },
      data: {
        currentNodeId: next.id,
        visitedNodeIds: [...visited, next.id],
        playerHp: hp,
        accumulatedLoot: json(loot),
        revision: { increment: 1 },
      },
    });
  }

  private async battleAction(
    tx: Tx,
    member: RoomMember,
    run: MapRun,
    command: Extract<GameCommand, { type: 'ROLL' | 'DECISION' }>,
    now: Date,
  ): Promise<MapRun> {
    const battle = await tx.battle.findFirst({
      where: { id: command.battleId, runId: run.id, nodeId: run.currentNodeId },
    });
    requireRule(battle, 'BATTLE_NOT_FOUND', 'Бой не найден в текущем узле.');
    await tx.$queryRaw`SELECT id FROM "Battle" WHERE id=${battle.id}::uuid FOR UPDATE`;
    requireRule(battle.state !== 'FINISHED', 'BATTLE_FINISHED', 'Бой уже завершён.');
    const die = parseCombatDie(run.dieSnapshot);
    const state = readCombat(battle, run);
    const random = command.type === 'ROLL' || command.action === 'REROLL';
    const face = random ? battleFace(battle.battleSeed, battle.stepIndex) : undefined;
    const result =
      command.type === 'ROLL'
        ? rollCombat(state, face!)
        : decideCombat(state, die, command.action, face);
    await tx.battle.update({
      where: { id: battle.id },
      data: { ...battleData(result), stepIndex: random ? { increment: 1 } : undefined },
    });
    let loot = this.readLoot(run, run.accumulatedLoot);
    const node = mapSchema.parse(run.dagMapData).find((n) => n.id === run.currentNodeId)!;
    if (result.outcome === 'VICTORY') {
      loot = this.collectLoot(run, node);
      await tx.die.updateMany({
        where: { id: die.id, ownerId: member.id, contentVersion: die.contentVersion ?? 0 },
        data: { lastVictoryAt: now, lastVictoryPowerScore: die.powerScore },
      });
    }
    let updated = await tx.mapRun.update({
      where: { id: run.id },
      data: { playerHp: result.playerHp, accumulatedLoot: json(loot), revision: { increment: 1 } },
    });
    if (result.outcome === 'DEFEAT' || (result.outcome === 'VICTORY' && node.type === 'BOSS'))
      updated = await this.settle(tx, member, updated, result.outcome, now);
    return updated;
  }

  private async settle(
    tx: Tx,
    member: RoomMember,
    run: MapRun,
    outcome: 'VICTORY' | 'DEFEAT',
    now: Date,
  ): Promise<MapRun> {
    requireRule(
      run.lootSettledAt === null && run.status === 'IN_PROGRESS',
      'ALREADY_SETTLED',
      'Награда уже выдана.',
    );
    const victory = outcome === 'VICTORY';
    let draw = 0;
    const reward =
      run.mode === 'EXPEDITION'
        ? settleExpeditionLoot(expeditionLootSchema.parse(run.accumulatedLoot), victory, (max) =>
            secretInt(run.seed, 'settlement', draw++, max),
          )
        : settleLoot(lootSchema.parse(run.accumulatedLoot), victory);
    if (run.mode === 'EXPEDITION') {
      const full = expeditionLootSchema.parse(reward);
      for (const currency of full.spheres)
        await tx.userCurrency.upsert({
          where: { ownerId_sphereType: { ownerId: member.id, sphereType: currency.type } },
          create: { ownerId: member.id, sphereType: currency.type, amount: currency.amount },
          update: { amount: { increment: currency.amount } },
        });
      for (const die of full.dice)
        await tx.pendingDrop.create({
          data: {
            id: die.id,
            ownerId: member.id,
            runId: run.id,
            dieData: json(die),
            createdAt: now,
          },
        });
    }
    await tx.roomMember.update({
      where: { id: member.id },
      data: {
        gold: { increment: reward.gold },
        facetDust: { increment: reward.dust },
        inventoryRevision: { increment: 1 },
        tutorialTrainingWon: run.mode === 'TRAINING' && victory ? true : undefined,
        highestExpeditionLevel:
          run.mode === 'EXPEDITION' && victory
            ? Math.max(member.highestExpeditionLevel, run.level)
            : undefined,
        // Фрагмент печати — награда за победу в обычной экспедиции; тренировка его не даёт.
        sealFragments: run.mode === 'EXPEDITION' && victory ? { increment: 1 } : undefined,
      },
    });
    return tx.mapRun.update({
      where: { id: run.id },
      data: { status: outcome, completedAt: now, settledLoot: json(reward), lootSettledAt: now },
    });
  }

  private readLoot(run: MapRun, data: unknown) {
    return run.mode === 'EXPEDITION' ? expeditionLootSchema.parse(data) : lootSchema.parse(data);
  }
  private publicLoot(run: MapRun, data: unknown): RunLootDTO {
    if (run.mode === 'TRAINING') return lootSchema.parse(data);
    const loot = expeditionLootSchema.parse(data);
    return { ...loot, dice: loot.dice.map(toDropDTO) };
  }
  private collectLoot(run: MapRun, node: MapNodeDTO) {
    if (run.mode === 'TRAINING')
      return addLoot(lootSchema.parse(run.accumulatedLoot), trainingReward(node.type));
    let step = 0;
    return addExpeditionLoot(
      expeditionLootSchema.parse(run.accumulatedLoot),
      expeditionReward(
        node.type,
        run.level,
        (max) => secretInt(run.seed, `loot:${node.id}`, step++, max),
        randomUUID,
      ),
    );
  }

  private async snapshot(tx: Tx, run: MapRun): Promise<RunDTO> {
    if (!run.dieSnapshot)
      throw new GameRuleError('UNSUPPORTED_RUN', 'Этот поход создан до запуска боевой системы.');
    const die = parseCombatDie(run.dieSnapshot);
    const nodes = mapSchema.parse(run.dagMapData);
    const battle = await tx.battle.findFirst({
      where: { runId: run.id, nodeId: run.currentNodeId },
    });
    const state = battle ? readCombat(battle, run) : null;
    const available =
      run.status === 'IN_PROGRESS' && (!state || state.state === 'FINISHED')
        ? (nodes.find((n) => n.id === run.currentNodeId)?.next ?? [])
        : [];
    return {
      id: run.id,
      revision: run.revision,
      mode: run.mode,
      level: run.level,
      status: run.status,
      currentNodeId: run.currentNodeId,
      visitedNodeIds: readVisited(run.visitedNodeIds),
      nodes,
      availableNodeIds: available,
      playerHp: run.playerHp,
      playerMaxHp: run.playerMaxHp,
      loadout: die,
      loot: this.publicLoot(run, run.accumulatedLoot),
      reward: run.settledLoot ? this.publicLoot(run, run.settledLoot) : null,
      battle:
        battle && state
          ? {
              id: battle.id,
              ...state,
              enemyName: ENEMIES[state.enemyType].name,
              options: combatOptions(state, die),
            }
          : null,
    };
  }
}
function readVisited(value: Prisma.JsonValue): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string'))
    throw new Error('Invalid visited nodes');
  return value;
}
function readCombat(battle: Battle, run: MapRun): CombatState {
  if (!ENEMY_TYPES.includes(battle.enemyType as EnemyType)) throw new Error('Invalid enemy');
  return {
    state: battle.state,
    currentRolledFace: battle.currentRolledFace,
    focusCharges: battle.focusCharges,
    rerollsLeft: battle.rerollsLeft,
    turnNumber: battle.turnNumber,
    playerHp: run.playerHp,
    playerMaxHp: run.playerMaxHp,
    playerShield: battle.playerShield,
    enemyType: battle.enemyType as EnemyType,
    enemyScale: run.enemyScale,
    enemyHp: battle.enemyHp,
    enemyMaxHp: battle.enemyMaxHp,
    enemyShield: battle.enemyShield,
    currentIntent: intentSchema.parse(battle.currentIntent),
    effects: effectsSchema.parse(battle.effects),
    outcome: battle.outcome,
    log: combatLogSchema.parse(battle.log),
  };
}
function battleData(state: CombatState) {
  return {
    state: state.state,
    currentRolledFace: state.currentRolledFace,
    focusCharges: state.focusCharges,
    rerollsLeft: state.rerollsLeft,
    turnNumber: state.turnNumber,
    playerShield: state.playerShield,
    enemyType: state.enemyType,
    enemyHp: state.enemyHp,
    enemyMaxHp: state.enemyMaxHp,
    enemyShield: state.enemyShield,
    currentIntent: json(state.currentIntent),
    effects: json(state.effects),
    outcome: state.outcome,
    log: json(state.log),
  };
}
