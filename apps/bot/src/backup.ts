import {
  assertRestorableSize,
  createBackup,
  encodeBackup,
  MAX_RESTORABLE_BYTES,
} from '@dicebound/db';
import type { BackupPayload, EncodedBackup, PrismaClient } from '@dicebound/db';

export interface BackupChannel {
  sendDocument(bytes: Uint8Array, filename: string, caption: string): Promise<unknown>;
  sendText(text: string): Promise<unknown>;
}

export interface BackupOptions {
  db: PrismaClient;
  channel: BackupChannel;
  clock?: () => Date;
  log?: (message: string) => void;
}

export interface BackupSchedulerOptions extends BackupOptions {
  intervalMs?: number;
  /**
   * Снимать ли копию сразу при старте.
   *
   * По умолчанию нет: бесплатный инстанс Render засыпает и просыпается, поэтому
   * снимок при каждом старте завалил бы личные сообщения админа одинаковыми
   * файлами. Первую копию админ снимает командой /backup.
   */
  immediate?: boolean;
}

export interface BackupResult {
  encoded: EncodedBackup;
  payload: BackupPayload;
  filename: string;
}

/** Имя файла без символов, неудобных в файловых системах. */
export function backupFilename(createdAt: Date): string {
  const stamp = createdAt
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d{3}Z$/, 'Z');
  return `dicebound-backup-${stamp}.json.gz`;
}

export function backupCaption(encoded: EncodedBackup): string {
  const sizeKb = (encoded.sizeBytes / 1024).toFixed(1);
  return [
    '💾 Резервная копия базы Dicebound',
    `Снята: ${encoded.createdAt}`,
    `Строк: ${encoded.rowCount}`,
    `Размер: ${sizeKb} КБ`,
    `SHA-256: ${encoded.checksum.slice(0, 16)}…`,
    '',
    'Восстановление: npm run db:restore -- <файл>',
  ].join('\n');
}

/**
 * Отправляет готовый снимок в личные сообщения админа.
 *
 * Снимок больше предела скачивания Bot API не отправляется: бот не смог бы
 * прочитать его обратно, а тихая отправка невосстановимой копии создаёт ложное
 * чувство защищённости. Вместо файла админ получает предупреждение с фактическим
 * размером, а вызывающий код — исключение.
 */
export async function deliverBackup(
  channel: BackupChannel,
  encoded: EncodedBackup,
  filename: string,
  log: (message: string) => void = () => undefined,
): Promise<void> {
  try {
    assertRestorableSize(encoded.sizeBytes);
  } catch (error) {
    const sizeMb = (encoded.sizeBytes / 1024 / 1024).toFixed(1);
    const limitMb = (MAX_RESTORABLE_BYTES / 1024 / 1024).toFixed(0);
    await channel.sendText(
      `⚠️ Резервная копия не отправлена: ${sizeMb} МБ превышает предел скачивания Bot API ${limitMb} МБ.\n` +
        `Строк в базе: ${encoded.rowCount}.\n` +
        'Такой файл невозможно восстановить через бота. Выгрузите базу внешним способом.',
    );
    log(
      `Backup skipped: ${encoded.sizeBytes} bytes exceeds the ${MAX_RESTORABLE_BYTES} byte limit`,
    );
    throw error;
  }

  await channel.sendDocument(encoded.bytes, filename, backupCaption(encoded));
  log(`Backup sent: ${filename}, ${encoded.sizeBytes} bytes, ${encoded.rowCount} rows`);
}

/** Снимает копию базы и отправляет её админу. */
export async function runBackup(options: BackupOptions): Promise<BackupResult> {
  const clock = options.clock ?? (() => new Date());
  const payload = await createBackup(options.db, { now: clock });
  const encoded = encodeBackup(payload);
  const filename = backupFilename(new Date(payload.createdAt));
  await deliverBackup(options.channel, encoded, filename, options.log);
  return { encoded, payload, filename };
}

/**
 * Периодическая отправка резервных копий.
 *
 * Устроена как диспетчер анонсов: сбой одного снимка не останавливает
 * планировщик и не роняет процесс.
 */
export function startBackupScheduler(options: BackupSchedulerOptions): () => void {
  const interval = options.intervalMs ?? 6 * 60 * 60 * 1_000;
  const log = options.log ?? (() => undefined);
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    try {
      await runBackup(options);
    } catch (error) {
      log(`Backup failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (!stopped) timer = setTimeout(() => void tick(), interval);
    }
  };

  timer = setTimeout(() => void tick(), options.immediate ? 0 : interval);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
