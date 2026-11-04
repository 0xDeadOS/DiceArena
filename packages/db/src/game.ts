import { createHash } from 'node:crypto';
import {
  addLoot,
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
  BattleRollRequest,
  CombatState,
  EnemyType,
  MapStepRequest,
  RoomContext,
  RunDTO,
  RunMutation,
  TelegramIdentity,
} from '@dicebound/shared-types';
import { Prisma } from './generated/prisma/client.js';
import type { PrismaClient } from './generated/prisma/client.js';
import type { Battle, MapRun, RoomMember } from './generated/prisma/client.js';
import { battleFace, newSecretSeed, secretInt } from './random.js';

export type GameCommand =
  | { type: 'START' }
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
type Tx = Prisma.TransactionClient;
function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}
const fingerprint = (command: GameCommand) =>
  createHash('sha256')
    .update(`game:v1:${canonical(command)}`)
    .digest('hex');

export class PrismaGameRepository implements GameRepository {
  constructor(private readonly db: PrismaClient) {}

  async current(room: RoomContext, identity: TelegramIdentity): Promise<RunDTO | null> {
    return this.db.$transaction(async (tx) => {
      const member = await this.lockMember(tx, room, identity);
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
    requireRule(
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(key),
      'INVALID_IDEMPOTENCY_KEY',
      'Нужен UUIDv4 Idempotency-Key.',
    );
    return this.db.$transaction(async (tx) => {
      // All gameplay writes use the same lock order: member -> run -> battle.
      const member = await this.lockMember(tx, room, identity);
      const hash = fingerprint(command);
      const previous = await tx.idempotencyRecord.findUnique({
        where: { memberId_key: { memberId: member.id, key } },
      });
      if (previous) {
        requireRule(
          previous.requestHash === hash,
          'IDEMPOTENCY_CONFLICT',
          'Этот ключ уже использован для другого действия.',
        );
        requireRule(
          previous.expiresAt > now && previous.responseStatus === 200,
          'IDEMPOTENCY_EXPIRED',
          'Срок повтора истёк. Обновите состояние похода.',
        );
        return previous.responseBody as unknown as RunDTO;
      }
      // Compact expired responses, but retain nonce tombstones: expiry never re-executes a command.
      await tx.idempotencyRecord.updateMany({
        where: { memberId: member.id, expiresAt: { lte: now }, responseStatus: 200 },
        data: { responseStatus: 409, responseBody: { expired: true } },
      });
      let run: MapRun;
      if (command.type === 'START') run = await this.start(tx, member);
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
      const response = await this.snapshot(tx, run);
      await tx.idempotencyRecord.create({
        data: {
          memberId: member.id,
          key,
          requestHash: hash,
          responseStatus: 200,
          responseBody: json(response),
          createdAt: now,
          expiresAt: new Date(now.getTime() + 86_400_000),
        },
      });
      return response;
    });
  }

  private async lockMember(
    tx: Tx,
    room: RoomContext,
    identity: TelegramIdentity,
  ): Promise<RoomMember> {
    const found = await tx.roomMember.findFirst({
      where: { roomId: room.id, user: { telegramUserId: BigInt(identity.id) } },
      select: { id: true },
    });
    requireRule(found, 'SESSION_REQUIRED', 'Сначала откройте игровую сессию.');
    await tx.$queryRaw`SELECT id FROM "RoomMember" WHERE id=${found.id}::uuid FOR UPDATE`;
    return tx.roomMember.findUniqueOrThrow({ where: { id: found.id } });
  }

  private async start(tx: Tx, member: RoomMember): Promise<MapRun> {
    requireRule(
      !(await tx.mapRun.findFirst({
        where: { ownerId: member.id, status: 'IN_PROGRESS' },
        select: { id: true },
      })),
      'ACTIVE_RUN_EXISTS',
      'Сначала завершите текущий поход.',
    );
    const item = member.equippedDieId
      ? await tx.die.findFirst({ where: { id: member.equippedDieId, ownerId: member.id } })
      : null;
    requireRule(item, 'NO_EQUIPPED_DIE', 'Сначала экипируйте кубик.');
    const die = parseCombatDie(item);
    const seed = newSecretSeed();
    let step = 0;
    const nodes = trainingMap((max) => secretInt(seed, 'map', step++, max));
    const hp = combatStats(die).maxHp;
    return tx.mapRun.create({
      data: {
        ownerId: member.id,
        seed,
        hasVigorBoost: false,
        dagMapData: json(nodes),
        visitedNodeIds: ['start'],
        dieSnapshot: json(die),
        playerHp: hp,
        playerMaxHp: hp,
        accumulatedLoot: { gold: 0, dust: 0 },
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
    let loot = lootSchema.parse(run.accumulatedLoot);
    if (next.type === 'CHEST') loot = addLoot(loot, trainingReward('CHEST'));
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
      const state = newCombat(type, die, hp, run.playerMaxHp);
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
    let loot = lootSchema.parse(run.accumulatedLoot);
    const node = mapSchema.parse(run.dagMapData).find((n) => n.id === run.currentNodeId)!;
    if (result.outcome === 'VICTORY') {
      loot = addLoot(loot, trainingReward(node.type));
      await tx.die.updateMany({
        where: { id: die.id, ownerId: member.id },
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
    const reward = settleLoot(lootSchema.parse(run.accumulatedLoot), outcome === 'VICTORY');
    await tx.roomMember.update({
      where: { id: member.id },
      data: { gold: { increment: reward.gold }, facetDust: { increment: reward.dust } },
    });
    return tx.mapRun.update({
      where: { id: run.id },
      data: { status: outcome, completedAt: now, settledLoot: json(reward), lootSettledAt: now },
    });
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
      mode: 'TRAINING',
      status: run.status,
      currentNodeId: run.currentNodeId,
      visitedNodeIds: readVisited(run.visitedNodeIds),
      nodes,
      availableNodeIds: available,
      playerHp: run.playerHp,
      playerMaxHp: run.playerMaxHp,
      loadout: die,
      loot: lootSchema.parse(run.accumulatedLoot),
      reward: run.settledLoot ? lootSchema.parse(run.settledLoot) : null,
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
