import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
  DEFERRED_COLUMNS,
  MAX_RESTORABLE_BYTES,
  assertRestorableSize,
  decodeBackup,
  encodeBackup,
} from './backup.js';
import type { BackupPayload } from './backup.js';

const emptyPayload = (): BackupPayload => ({
  formatVersion: BACKUP_FORMAT_VERSION,
  createdAt: '2026-11-06T00:00:00.000Z',
  rowCount: 0,
  tables: Object.fromEntries(BACKUP_TABLES.map((table) => [table, []])),
});

describe('Манифест таблиц снимка', () => {
  it('перечисляет все модели схемы без пропусков и дублей', async () => {
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{$/gm)].map((match) => match[1]);

    // Защита от дрейфа: новая модель в схеме обязана попасть в манифест,
    // иначе её строки молча не войдут в резервную копию.
    expect([...BACKUP_TABLES].sort()).toEqual([...models].sort());
    expect(new Set(BACKUP_TABLES).size).toBe(BACKUP_TABLES.length);
  });

  it('откладывает только существующие таблицы', () => {
    for (const table of Object.keys(DEFERRED_COLUMNS))
      expect(BACKUP_TABLES).toContain(table as (typeof BACKUP_TABLES)[number]);
  });
});

describe('Кодирование снимка', () => {
  it('сохраняет строки без потерь после сжатия и распаковки', () => {
    const payload = emptyPayload();
    // Значения, которые JSON переносит плохо: дата уже строкой, вложенный JSON,
    // пустые и нулевые поля.
    payload.tables.Room = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        slug: 'r_abcdefgh',
        telegramChatId: '-1001234567890',
        title: 'Обитель «друзей»',
        canSendMessages: true,
        sealFragments: 0,
        createdAt: '2026-11-04T12:00:00.000Z',
        updatedAt: null,
      },
    ];
    payload.tables.Die = [{ faces: [{ face: 'STRIKE', value: 6 }], affixes: [] }];
    payload.rowCount = 2;

    const decoded = decodeBackup(encodeBackup(payload).bytes);

    expect(decoded).toEqual(payload);
    expect(decoded.rowCount).toBe(2);
  });

  it('сжимает снимок', () => {
    const payload = emptyPayload();
    payload.tables.Room = Array.from({ length: 500 }, (_, index) => ({
      id: `room-${index}`,
      title: 'Обитель друзей'.repeat(4),
    }));
    const encoded = encodeBackup(payload);
    expect(encoded.sizeBytes).toBeLessThan(JSON.stringify(payload).length);
    expect(encoded.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it('отклоняет чужую версию формата', () => {
    const payload = { ...emptyPayload(), formatVersion: BACKUP_FORMAT_VERSION + 1 };
    const encoded = encodeBackup(payload);
    expect(() => decodeBackup(encoded.bytes)).toThrow(/Unsupported backup format/);
  });

  it('отклоняет снимок без обязательной таблицы', () => {
    const payload = emptyPayload();
    delete payload.tables.Room;
    expect(() => decodeBackup(encodeBackup(payload).bytes)).toThrow(/missing table Room/);
  });

  it('отклоняет повреждённые байты', () => {
    expect(() => decodeBackup(new Uint8Array([1, 2, 3]))).toThrow();
  });
});

describe('Предел скачивания через Bot API', () => {
  it('пропускает снимок внутри предела', () => {
    expect(() => assertRestorableSize(MAX_RESTORABLE_BYTES)).not.toThrow();
    expect(() => assertRestorableSize(MAX_RESTORABLE_BYTES - 1)).not.toThrow();
  });

  it('отклоняет снимок, который бот не сможет скачать обратно', () => {
    // Отправить можно до 50 МБ, но getFile читает только до 20 МБ, поэтому
    // такой файл нельзя отдавать молча.
    expect(() => assertRestorableSize(MAX_RESTORABLE_BYTES + 1)).toThrow(
      /above the 20971520 byte Bot API download limit/,
    );
  });

  it('предел равен 20 МБ', () => {
    expect(MAX_RESTORABLE_BYTES).toBe(20 * 1024 * 1024);
  });
});
