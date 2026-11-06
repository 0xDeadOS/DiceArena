import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  BACKUP_TABLES,
  createBackup,
  decodeBackup,
  encodeBackup,
  restoreBackup,
} from '../src/index.js';
import type { PrismaClient } from '../src/index.js';
import { starterFaces } from '../../game-core/src/index.js';
import { databaseHarness } from './harness.js';
import type { DatabaseHarness } from './harness.js';
import { NOW } from '../../../tests/fixtures.js';

let harness: DatabaseHarness;
let db: PrismaClient;
const alice = { id: 42, firstName: 'Алиса', username: 'alice' };
const bob = { id: 43, firstName: 'Боб', username: null };
const chatId = -1001234567890n;

beforeAll(async () => {
  harness = await databaseHarness();
  db = harness.db;
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

/**
 * Читает все таблицы сырым SQL и приводит строки к сравниваемому виду.
 *
 * Сравнение идёт по сырым строкам базы, а не по DTO: так тест ловит потерю
 * точности типов (BigInt, TIMESTAMPTZ, JSONB, enum), которую DTO скрыли бы.
 */
async function snapshotAllTables(): Promise<Record<string, Record<string, unknown>[]>> {
  const result: Record<string, Record<string, unknown>[]> = {};
  for (const table of BACKUP_TABLES) {
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(`SELECT * FROM "${table}"`);
    result[table] = rows
      .map((row) =>
        Object.fromEntries(
          Object.entries(row).map(([key, value]) => [
            key,
            value instanceof Date
              ? value.toISOString()
              : typeof value === 'bigint'
                ? value.toString()
                : value,
          ]),
        ),
      )
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return result;
}

/**
 * Заполняет таблицы, которых не касается вход игрока: экспедиция, бой, рейд,
 * удар, идемпотентность, событие и ожидаемый дроп.
 */
async function seedRemainingTables(memberId: string): Promise<void> {
  const runId = randomUUID();
  const raidId = randomUUID();
  const dropId = randomUUID();

  await db.mapRun.create({
    data: {
      id: runId,
      ownerId: memberId,
      seed: 'a'.repeat(64),
      mode: 'EXPEDITION',
      level: 3,
      // CHECK MapRun_mode_level_scale: для EXPEDITION масштаб 1000..5000.
      enemyScale: 1200,
      hasVigorBoost: true,
      dagMapData: { nodes: [{ id: 'start', kind: 'START' }] },
      playerHp: 40,
      playerMaxHp: 55,
      accumulatedLoot: { gold: 12, dust: 1 },
      visitedNodeIds: ['start'],
      completedAt: new Date('2026-11-05T10:00:00.000Z'),
    },
  });
  await db.battle.create({
    data: {
      runId,
      battleSeed: 'b'.repeat(64),
      currentIntent: { kind: 'STRIKE', value: 6 },
      effects: { poison: 2 },
      log: [{ turn: 1, text: 'Удар' }],
      enemyType: 'HOLLOW_CARRIER',
      enemyHp: 18,
      enemyMaxHp: 30,
      nodeId: 'start',
    },
  });
  await db.pendingDrop.create({
    data: {
      id: dropId,
      ownerId: memberId,
      runId,
      // CHECK PendingDrop_identity требует dieData->>'id' = id::text.
      dieData: { id: dropId, baseType: 'IRON', faces: [] },
    },
  });
  await db.raidInstance.create({
    data: {
      id: raidId,
      roomId: (await db.roomMember.findUniqueOrThrow({ where: { id: memberId } })).roomId,
      bossName: 'Страж Обители',
      maxHp: 60,
      // CHECK RaidInstance_status_consistent: DEFEATED требует currentHp = 0
      // и defeatedAt; трофей и заявка допустимы только после победы.
      status: 'DEFEATED',
      currentHp: 0,
      shield: 2,
      phase: 3,
      trophySeed: 'c'.repeat(64),
      claimedBy: memberId,
      expiresAt: new Date('2026-11-07T00:00:00.000Z'),
      defeatedAt: new Date('2026-11-06T01:02:03.456Z'),
    },
  });
  await db.raidAttack.create({
    data: {
      raidId,
      memberId,
      attackSeed: 'd'.repeat(64),
      // CHECK RaidAttack_state_consistent: FINISHED требует finishedAt, action
      // и faceValue при пустом currentRolledFace.
      state: 'FINISHED',
      damageDealt: 9,
      faceValue: 5,
      action: 'STRIKE',
      finishedAt: new Date('2026-11-06T01:00:00.000Z'),
    },
  });
  await db.idempotencyRecord.create({
    data: {
      key: randomUUID(),
      memberId,
      requestHash: 'e'.repeat(64),
      responseStatus: 200,
      responseBody: { ok: true, nested: { list: [1, 2, 3] } },
      expiresAt: new Date('2026-11-08T00:00:00.000Z'),
    },
  });
  await db.gameEvent.create({
    data: {
      roomId: (await db.roomMember.findUniqueOrThrow({ where: { id: memberId } })).roomId,
      memberId,
      eventType: 'RAID_DEFEATED',
      dedupKey: `raid:${raidId}:defeated`,
      payload: { title: 'Обитель освобождена', text: 'Страж повержен' },
      attempts: 2,
      sentAt: new Date('2026-11-06T01:05:00.000Z'),
    },
  });
}

describe('Снимок и восстановление базы', () => {
  it('восстанавливает базу построчно после полного стирания', async () => {
    const context = await harness.rooms.ensureRoom(chatId, 'Обитель друзей', 'r_abcdefgh');
    await harness.profiles.openSession(context, alice, NOW);
    await harness.profiles.openSession(context, bob, NOW);
    const member = await db.roomMember.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    await seedRemainingTables(member.id);

    // Исходное состояние: все 12 таблиц должны быть непустыми, иначе тест
    // молча не покрывает часть схемы.
    const before = await snapshotAllTables();
    for (const table of BACKUP_TABLES)
      expect(before[table]?.length, `таблица ${table} пуста до снимка`).toBeGreaterThan(0);

    const payload = await createBackup(db, { now: () => NOW });
    const encoded = encodeBackup(payload);
    const decoded = decodeBackup(encoded.bytes);

    await harness.reset();
    const wiped = await snapshotAllTables();
    for (const table of BACKUP_TABLES) expect(wiped[table]).toHaveLength(0);

    await restoreBackup(db, decoded);

    const after = await snapshotAllTables();
    expect(after).toEqual(before);
  });

  it('сохраняет ссылку на экипированный кубик через цикл внешних ключей', async () => {
    const context = await harness.rooms.ensureRoom(chatId, 'Обитель друзей', 'r_cyclefix');
    const hub = await harness.profiles.openSession(context, alice, NOW);
    const dieId = hub.inventory.dice[0]?.id;
    expect(dieId).toBeDefined();

    const equippedBefore = await db.roomMember.findFirstOrThrow();
    expect(equippedBefore.equippedDieId).toBe(dieId);

    await restoreBackup(db, decodeBackup(encodeBackup(await createBackup(db)).bytes));

    const equippedAfter = await db.roomMember.findFirstOrThrow();
    expect(equippedAfter.equippedDieId).toBe(dieId);
    expect(equippedAfter.id).toBe(equippedBefore.id);
  });

  it('сохраняет точность BigInt, дат, JSONB и enum', async () => {
    const context = await harness.rooms.ensureRoom(chatId, 'Обитель друзей', 'r_typesfix');
    await harness.profiles.openSession(context, alice, NOW);
    const member = await db.roomMember.findFirstOrThrow();
    await seedRemainingTables(member.id);
    const userCreatedBefore = (await db.user.findFirstOrThrow()).createdAt.toISOString();

    await restoreBackup(db, decodeBackup(encodeBackup(await createBackup(db)).bytes));

    const room = await db.room.findFirstOrThrow();
    // BigInt вне диапазона Number: сравнение строкой, иначе потеря точности.
    expect(room.telegramChatId.toString()).toBe(chatId.toString());

    const user = await db.user.findFirstOrThrow();
    expect(user.telegramUserId.toString()).toBe('42');
    // createdAt заполняется @default(now()) по часам базы, поэтому сверяем
    // не с NOW, а со значением до восстановления.
    expect(user.createdAt.toISOString()).toBe(userCreatedBefore);

    const die = await db.die.findFirstOrThrow();
    expect(die.faces).toEqual(starterFaces().map((face) => ({ ...face })));
    expect(die.rarity).toBe('NORMAL');
    expect(die.baseType).toBe('BONE');

    const event = await db.gameEvent.findFirstOrThrow();
    expect(event.payload).toEqual({ title: 'Обитель освобождена', text: 'Страж повержен' });
    expect(event.eventType).toBe('RAID_DEFEATED');
    expect(event.sentAt?.toISOString()).toBe('2026-11-06T01:05:00.000Z');

    // updatedAt помечен @updatedAt: сырая вставка обязана сохранить снимок,
    // а не перезаписать поле текущим временем.
    const restored = await db.room.findFirstOrThrow();
    expect(restored.updatedAt.toISOString()).toBe(room.updatedAt.toISOString());
  });

  it('откатывает восстановление целиком, если снимок повреждён', async () => {
    const context = await harness.rooms.ensureRoom(chatId, 'Обитель друзей', 'r_rollback');
    await harness.profiles.openSession(context, alice, NOW);
    const payload = await createBackup(db);
    const before = await snapshotAllTables();

    // Кубик без владельца нарушает внешний ключ: транзакция обязана откатиться,
    // а не оставить базу наполовину перезаписанной.
    const broken = structuredClone(payload);
    broken.tables.Die?.push({
      ...(broken.tables.Die?.[0] ?? {}),
      id: randomUUID(),
      ownerId: randomUUID(),
    });

    await expect(restoreBackup(db, broken)).rejects.toThrow();

    expect(await snapshotAllTables()).toEqual(before);
  });
});
