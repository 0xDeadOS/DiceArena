import { describe, expect, it, vi } from 'vitest';
import {
  MAX_RESTORABLE_BYTES,
  encodeBackup,
  BACKUP_FORMAT_VERSION,
  BACKUP_TABLES,
} from '@dicebound/db';
import type { EncodedBackup, PrismaClient } from '@dicebound/db';
import { backupCaption, backupFilename, deliverBackup, startBackupScheduler } from './backup.js';
import type { BackupChannel } from './backup.js';

const channel = (): BackupChannel & {
  documents: { filename: string; caption: string; bytes: Uint8Array }[];
  texts: string[];
} => {
  const documents: { filename: string; caption: string; bytes: Uint8Array }[] = [];
  const texts: string[] = [];
  return {
    documents,
    texts,
    sendDocument: async (bytes, filename, caption) => {
      documents.push({ bytes, filename, caption });
    },
    sendText: async (text) => {
      texts.push(text);
    },
  };
};

const encodedOf = (rowCount: number): EncodedBackup =>
  encodeBackup({
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: '2026-11-06T12:00:00.000Z',
    rowCount,
    tables: Object.fromEntries(BACKUP_TABLES.map((table) => [table, []])),
  });

describe('Имя файла и подпись снимка', () => {
  it('не содержит двоеточий и заканчивается на .json.gz', () => {
    const name = backupFilename(new Date('2026-11-06T12:34:56.789Z'));
    expect(name).toBe('dicebound-backup-2026-11-06T12-34-56Z.json.gz');
    expect(name).not.toContain(':');
  });

  it('подпись содержит размер, число строк и способ восстановления', () => {
    const caption = backupCaption(encodedOf(42));
    expect(caption).toContain('Строк: 42');
    expect(caption).toContain('КБ');
    expect(caption).toContain('npm run db:restore');
  });
});

describe('Отправка снимка', () => {
  it('отправляет документ с именем и подписью', async () => {
    const target = channel();
    const encoded = encodedOf(7);

    await deliverBackup(target, encoded, 'dicebound-backup-test.json.gz');

    expect(target.texts).toHaveLength(0);
    expect(target.documents).toHaveLength(1);
    expect(target.documents[0]?.filename).toBe('dicebound-backup-test.json.gz');
    expect(target.documents[0]?.caption).toContain('Строк: 7');
    expect(target.documents[0]?.bytes.byteLength).toBe(encoded.sizeBytes);
  });

  it('не отправляет снимок, который бот не сможет скачать обратно', async () => {
    const target = channel();
    // Отправить можно до 50 МБ, но getFile читает только до 20 МБ.
    const oversized: EncodedBackup = {
      ...encodedOf(1_000),
      sizeBytes: MAX_RESTORABLE_BYTES + 1,
    };

    await expect(deliverBackup(target, oversized, 'dicebound-backup-big.json.gz')).rejects.toThrow(
      /Bot API download limit/,
    );

    // Файл не уходит: невосстановимая копия создаёт ложное чувство защиты.
    expect(target.documents).toHaveLength(0);
    expect(target.texts).toHaveLength(1);
    expect(target.texts[0]).toContain('не отправлена');
    expect(target.texts[0]).toContain('1000');
  });

  it('пропускает снимок ровно на пределе', async () => {
    const target = channel();
    const atLimit: EncodedBackup = { ...encodedOf(1), sizeBytes: MAX_RESTORABLE_BYTES };

    await deliverBackup(target, atLimit, 'dicebound-backup-limit.json.gz');

    expect(target.documents).toHaveLength(1);
    expect(target.texts).toHaveLength(0);
  });
});

describe('Планировщик', () => {
  // База недоступна: планировщик обязан пережить сбой и не уронить процесс.
  const failingDb = {
    $transaction: async () => {
      throw new Error('нет соединения с базой');
    },
  } as unknown as PrismaClient;

  it('переживает сбой снимка и продолжает работу', async () => {
    const log = vi.fn();
    const stop = startBackupScheduler({
      db: failingDb,
      channel: channel(),
      immediate: true,
      intervalMs: 5,
      log,
    });

    await new Promise((resolve) => setTimeout(resolve, 30));
    stop();
    const callsAfterStop = log.mock.calls.length;
    expect(callsAfterStop).toBeGreaterThan(0);
    expect(log.mock.calls.flat().join(' ')).toContain('нет соединения с базой');

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(log.mock.calls.length).toBe(callsAfterStop);
  });

  it('по умолчанию не снимает копию при старте', async () => {
    const log = vi.fn();
    const stop = startBackupScheduler({
      db: failingDb,
      channel: channel(),
      intervalMs: 10_000,
      log,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    stop();

    // Иначе каждое пробуждение бесплатного инстанса славило бы новый файл.
    expect(log).not.toHaveBeenCalled();
  });
});
