import { createHash } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import type { PrismaClient } from './generated/prisma/client.js';
import { Prisma } from './generated/prisma/client.js';

/** Версия формата снимка. Меняется при несовместимом изменении структуры. */
export const BACKUP_FORMAT_VERSION = 1;

/**
 * Предел скачивания файла через Bot API `getFile` — 20 МБ.
 *
 * Отправить бот может до 50 МБ, но прочитать обратно только до 20 МБ, поэтому
 * снимок больше этого предела восстановить невозможно. Такой файл нельзя
 * отдавать молча: его обязан отклонить вызывающий код.
 */
export const MAX_RESTORABLE_BYTES = 20 * 1024 * 1024;

/**
 * Порядок обхода таблиц, построенный по внешним ключам: сначала таблицы без
 * ссылок, затем те, что ссылаются только на уже перечисленные.
 *
 * В схеме есть один цикл — `RoomMember.equippedDieId` ссылается на `Die`, а
 * `Die.ownerId` на `RoomMember`, и ограничение не откладываемое. Поэтому
 * `equippedDieId` вынесен в отдельную фазу (см. `DEFERRED_COLUMNS`).
 */
export const BACKUP_TABLES = [
  'Room',
  'User',
  'RoomMember',
  'Die',
  'UserCurrency',
  'MapRun',
  'IdempotencyRecord',
  'RaidInstance',
  'RaidAttack',
  'GameEvent',
  'Battle',
  'PendingDrop',
] as const;

/**
 * Столбцы, которые нельзя записать вместе со своей строкой.
 *
 * `RoomMember.equippedDieId` ссылается на `Die`, которого на момент вставки
 * участника ещё нет. Строка создаётся с пустой ссылкой, ссылка возвращается
 * после загрузки `Die`.
 */
export const DEFERRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  RoomMember: ['equippedDieId'],
};

export type BackupRow = Record<string, unknown>;

export interface BackupPayload {
  formatVersion: number;
  /** Момент снятия в ISO-8601. */
  createdAt: string;
  /** Суммарное число строк во всех таблицах. */
  rowCount: number;
  /** Строки по таблицам в порядке `BACKUP_TABLES`. */
  tables: Record<string, BackupRow[]>;
}

export interface EncodedBackup {
  /** Сжатые байты для отправки. */
  bytes: Uint8Array;
  sizeBytes: number;
  /** SHA-256 сжатых байт, для проверки целостности. */
  checksum: string;
  rowCount: number;
  createdAt: string;
}

interface RawClient {
  $queryRawUnsafe<T>(sql: string, ...parameters: unknown[]): Promise<T>;
  $executeRawUnsafe(sql: string, ...parameters: unknown[]): Promise<number>;
}

interface ColumnMeta {
  name: string;
  /** `data_type` из information_schema, например `jsonb` или `uuid`. */
  type: string;
}

/** Идентификатор в кавычках. Имена берутся из information_schema, не от пользователя. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function currentSchema(client: RawClient): Promise<string> {
  const rows =
    await client.$queryRawUnsafe<{ current_schema: string | null }[]>('SELECT current_schema()');
  const schema = rows[0]?.current_schema;
  if (!schema) throw new Error('Backup failed: current schema is not set');
  return schema;
}

async function readColumns(
  client: RawClient,
  schema: string,
  table: string,
): Promise<ColumnMeta[]> {
  const rows = await client.$queryRawUnsafe<{ column_name: string; data_type: string }[]>(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
      ORDER BY ordinal_position`,
    schema,
    table,
  );
  if (rows.length === 0) throw new Error(`Backup failed: table ${table} has no columns`);
  return rows.map((row) => ({ name: row.column_name, type: row.data_type }));
}

/**
 * Приводит значение из базы к виду, переживающему JSON.
 *
 * `JSON.stringify` падает на BigInt, а `Date` превращается в строку без пометки
 * о типе, поэтому дата приводится к ISO явно. Остальное node-postgres уже
 * отдаёт в JSON-совместимом виде (`bigint` приходит строкой).
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Buffer.isBuffer(value)) return value.toString('base64');
  return value;
}

/**
 * Снимок всей базы в одной транзакции.
 *
 * Уровень `RepeatableRead` обязателен: без него таблицы читаются в разные
 * моменты и снимок может содержать участника без его комнаты.
 */
export async function createBackup(
  db: PrismaClient,
  options: { now?: () => Date } = {},
): Promise<BackupPayload> {
  const now = options.now ?? (() => new Date());
  const tables: Record<string, BackupRow[]> = {};
  let rowCount = 0;

  await db.$transaction(
    async (tx) => {
      const client = tx as unknown as RawClient;
      for (const table of BACKUP_TABLES) {
        const rows = await client.$queryRawUnsafe<BackupRow[]>(`SELECT * FROM ${quote(table)}`);
        tables[table] = rows.map((row) => {
          const serialized: BackupRow = {};
          for (const [key, value] of Object.entries(row)) serialized[key] = serializeValue(value);
          return serialized;
        });
        rowCount += rows.length;
      }
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );

  return { formatVersion: BACKUP_FORMAT_VERSION, createdAt: now().toISOString(), rowCount, tables };
}

/** Сжимает снимок в байты для отправки. */
export function encodeBackup(payload: BackupPayload): EncodedBackup {
  const json = JSON.stringify(payload);
  const bytes = new Uint8Array(gzipSync(Buffer.from(json, 'utf8')));
  return {
    bytes,
    sizeBytes: bytes.byteLength,
    checksum: createHash('sha256').update(bytes).digest('hex'),
    rowCount: payload.rowCount,
    createdAt: payload.createdAt,
  };
}

/** Распаковывает снимок и проверяет версию формата. */
export function decodeBackup(bytes: Uint8Array): BackupPayload {
  const json = gunzipSync(Buffer.from(bytes)).toString('utf8');
  const payload = JSON.parse(json) as BackupPayload;
  if (payload.formatVersion !== BACKUP_FORMAT_VERSION)
    throw new Error(
      `Unsupported backup format ${payload.formatVersion}, expected ${BACKUP_FORMAT_VERSION}`,
    );
  for (const table of BACKUP_TABLES) {
    const rows = payload.tables?.[table];
    if (!Array.isArray(rows)) throw new Error(`Backup is missing table ${table}`);
  }
  return payload;
}

/**
 * Проверяет, что снимок можно будет прочитать обратно через Bot API.
 *
 * Бросает исключение вместо тихой отправки файла, который бот не сможет
 * скачать: отправить невосстановимую резервную копию хуже, чем не отправить.
 */
export function assertRestorableSize(sizeBytes: number): void {
  if (sizeBytes > MAX_RESTORABLE_BYTES)
    throw new Error(
      `Backup is ${sizeBytes} bytes, above the ${MAX_RESTORABLE_BYTES} byte Bot API download limit`,
    );
}

/**
 * Готовит параметры вставки: JSONB передаётся текстом, иначе строковое значение
 * JSON не проходит разбор, а дата — строкой ISO с явным приведением типа.
 */
function prepareValue(column: ColumnMeta, value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (column.type === 'jsonb' || column.type === 'json') return JSON.stringify(value) as unknown;
  if (column.type.startsWith('timestamp')) return String(value);
  return value;
}

const MAX_PARAMETERS = 65_535;

async function insertRows(
  client: RawClient,
  table: string,
  columns: ColumnMeta[],
  rows: BackupRow[],
  skip: readonly string[],
): Promise<void> {
  const used = columns.filter((column) => !skip.includes(column.name));
  if (used.length === 0 || rows.length === 0) return;

  const columnList = used.map((column) => quote(column.name)).join(', ');
  // Типы не приводим явно: в INSERT Postgres выводит тип параметра из
  // целевого столбца, а явное приведение к text ломает enum-столбцы.
  const placeholders = (offset: number) =>
    used.map((_column, index) => `$${offset + index + 1}`).join(', ');
  const batchSize = Math.max(1, Math.floor(MAX_PARAMETERS / used.length));

  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    const values: unknown[] = [];
    const tuples: string[] = [];
    batch.forEach((row, rowOffset) => {
      tuples.push(`(${placeholders(rowOffset * used.length)})`);
      for (const column of used) values.push(prepareValue(column, row[column.name]));
    });
    await client.$executeRawUnsafe(
      `INSERT INTO ${quote(table)} (${columnList}) VALUES ${tuples.join(', ')}`,
      ...values,
    );
  }
}

/**
 * Полное восстановление базы из снимка в одной транзакции.
 *
 * Внешние ключи и триггеры не отключаются: повреждённый снимок откатывает
 * транзакцию целиком, а не записывает несогласованные данные.
 */
export async function restoreBackup(db: PrismaClient, payload: BackupPayload): Promise<void> {
  if (payload.formatVersion !== BACKUP_FORMAT_VERSION)
    throw new Error(
      `Unsupported backup format ${payload.formatVersion}, expected ${BACKUP_FORMAT_VERSION}`,
    );

  await db.$transaction(async (tx) => {
    const client = tx as unknown as RawClient;
    const schema = await currentSchema(client);

    // Цикл RoomMember.equippedDieId -> Die разбирается до удаления: ограничение
    // ON DELETE NO ACTION не даст удалить кубик, пока на него есть ссылка.
    for (const [table, columns] of Object.entries(DEFERRED_COLUMNS)) {
      const assignments = columns.map((column) => `${quote(column)} = NULL`).join(', ');
      await client.$executeRawUnsafe(`UPDATE ${quote(table)} SET ${assignments}`);
    }

    const metadata = new Map<string, ColumnMeta[]>();
    for (const table of BACKUP_TABLES)
      metadata.set(table, await readColumns(client, schema, table));

    // Удаление в обратном порядке: сначала зависимые таблицы.
    for (const table of [...BACKUP_TABLES].reverse())
      await client.$executeRawUnsafe(`DELETE FROM ${quote(table)}`);

    // Вставка в прямом порядке, отложенные столбцы пока пустые.
    for (const table of BACKUP_TABLES) {
      const columns = metadata.get(table);
      if (!columns) continue;
      await insertRows(
        client,
        table,
        columns,
        payload.tables[table] ?? [],
        DEFERRED_COLUMNS[table] ?? [],
      );
    }

    // Возврат отложенных ссылок, когда целевые строки уже на месте.
    for (const [table, columns] of Object.entries(DEFERRED_COLUMNS)) {
      const rows = payload.tables[table] ?? [];
      for (const row of rows) {
        const id = row['id'];
        if (id === undefined) continue;
        for (const column of columns) {
          const value = row[column];
          if (value === null || value === undefined) continue;
          await client.$executeRawUnsafe(
            `UPDATE ${quote(table)} SET ${quote(column)} = $1 WHERE id = $2`,
            String(value),
            String(id),
          );
        }
      }
    }
  });
}
