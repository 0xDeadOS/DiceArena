/**
 * PATH OF DICE — src/cloudStorage.js
 * Вечный бесплатный бэкап в Telegram Cloud.
 *
 * При каждом изменении БД (с дебаунсом) сервер:
 *   1. сериализует data/db.json;
 *   2. загружает его документом в закреплённое сообщение в личке администратора
 *      (editMessageMedia, а если сообщения ещё нет — sendDocument + pinChatMessage);
 *   3. запоминает message_id и file_id в локальном state-файле.
 *
 * На старте restoreDbFromTelegramCloud() пытается скачать актуальный слепок,
 * чтобы контейнер на Render/Railway не терял прогресс.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FILE_NAME = 'path_of_dice_db.json';
const DEBOUNCE_MS = 5000;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export class CloudBackup {
  /**
   * @param {object} opts
   * @param {import('./store.js').GameStore} opts.store
   * @param {string} [opts.botToken]
   * @param {string|number} [opts.chatId] Telegram ID администратора
   * @param {string} [opts.apiBase]
   * @param {string} [opts.statePath]
   * @param {string} [opts.fileName]
   * @param {number} [opts.debounceMs]
   */
  constructor({
    store,
    botToken = process.env.BOT_TOKEN,
    chatId = process.env.ADMIN_ID,
    apiBase = 'https://api.telegram.org',
    statePath = path.join(process.cwd(), 'data', 'cloud-state.json'),
    fileName = DEFAULT_FILE_NAME,
    debounceMs = DEBOUNCE_MS,
    fetchImpl = globalThis.fetch,
    now = () => Date.now(),
    log = console.log,
  } = {}) {
    this.store = store;
    this.botToken = botToken || '';
    this.chatId = chatId ? String(chatId) : '';
    this.apiBase = apiBase.replace(/\/$/, '');
    this.statePath = statePath;
    this.fileName = fileName;
    this.debounceMs = debounceMs;
    this.fetch = fetchImpl;
    this.now = now;
    this.log = log;
    this.timer = null;
    this.inFlight = null;
    this.lastUploadAt = 0;
    this.lastUploadHash = null;
    this.lastError = null;
    this.queue = Promise.resolve();
    this.state = this.readState();
  }

  get enabled() {
    return Boolean(this.botToken && this.chatId && this.fetch);
  }

  readState() {
    try {
      if (fs.existsSync(this.statePath)) {
        return JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      }
    } catch (error) {
      this.log(`[cloud] state не прочитан: ${error.message}`);
    }
    return { messageId: null, fileId: null, chatId: null, updatedAt: 0, hash: null };
  }

  writeState(patch = {}) {
    this.state = { ...this.state, ...patch, updatedAt: this.now() };
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      this.log(`[cloud] state не записан: ${error.message}`);
    }
    return this.state;
  }

  /** Вызывается стором после каждой записи на диск. */
  schedule(dbDispatch = null) {
    if (!this.enabled) return;
    if (dbDispatch) this.pendingDb = dbDispatch;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.backupNow().catch((error) => {
        this.lastError = error.message;
        this.log(`[cloud] backup error: ${error.message}`);
      });
    }, this.debounceMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async call(method, params = {}, { timeoutMs = 20000 } = {}) {
    if (!this.enabled) throw new Error('Telegram Cloud не настроен (BOT_TOKEN/ADMIN_ID).');
    const url = `${this.apiBase}/bot${this.botToken}/${method}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await this.fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.ok === false) {
        throw new Error(`${method}: ${data.description || `HTTP ${response.status}`}`);
      }
      return data.result;
    } finally {
      clearTimeout(timer);
    }
  }

  async downloadFileById(fileId) {
    const info = await this.call('getFile', { file_id: fileId });
    const filePath = info?.file_path;
    if (!filePath) throw new Error('getFile не вернул file_path');
    const url = `${this.apiBase}/file/bot${this.botToken}/${filePath}`;
    const response = await this.fetch(url);
    if (!response.ok) throw new Error(`Скачивание файла: HTTP ${response.status}`);
    return response.text();
  }

  async downloadPinnedDocument() {
    const chat = await this.call('getChat', { chat_id: this.chatId });
    const document = chat?.pinned_message?.document;
    if (document?.file_id) {
      return {
        json: await this.downloadFileById(document.file_id),
        messageId: chat.pinned_message.message_id,
        fileId: document.file_id,
      };
    }
    throw new Error('В закреплённом сообщении нет документа.');
  }

  async downloadKnown() {
    if (!this.state.fileId && !this.state.messageId) {
      throw new Error('Нет сохранённого file_id/message_id.');
    }
    let message = null;
    let fileId = this.state.fileId;
    try {
      const found = await this.call('getMessage', {
        chat_id: this.chatId,
        message_id: this.state.messageId,
      });
      message = found;
      fileId = found?.document?.file_id || fileId;
    } catch {
      /* getMessage может быть недоступен — пробуем напрямую по file_id. */
    }
    if (fileId) {
      const json = await this.downloadFileById(fileId);
      return { json, messageId: message?.message_id || this.state.messageId, fileId };
    }
    throw new Error('Файл не найден ни в сообщении, ни по file_id.');
  }

  /**
   * Скачивает актуальный слепок БД. Возвращает объект или null.
   */
  async restore() {
    if (!this.enabled) {
      this.log('[cloud] restore пропущен: не настроено.');
      return null;
    }
    const attempts = [
      ['local state', () => this.downloadKnown()],
      ['pinned message', () => this.downloadPinnedDocument()],
    ];
    for (const [label, fn] of attempts) {
      try {
        const { json, messageId, fileId } = await fn();
        const parsed = JSON.parse(json);
        if (!parsed || !Array.isArray(parsed.players)) {
          throw new Error('слепок не похож на базу игры');
        }
        this.writeState({
          messageId: messageId || this.state.messageId,
          fileId: fileId || this.state.fileId,
          chatId: this.chatId,
          hash: sha256(json),
          restoredAt: this.now(),
        });
        this.log(`[cloud] ✅ БД восстановлена из Telegram Cloud (${label}, игроков: ${parsed.players.length}).`);
        return parsed;
      } catch (error) {
        this.log(`[cloud] restore (${label}) не удался: ${error.message}`);
      }
    }
    this.lastError = 'restore failed';
    return null;
  }

  async sendDocument(json) {
    const boundary = `----pathofdice${this.now()}${Math.floor(Math.random() * 1e6)}`;
    const filename = this.fileName;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this.chatId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\nPath of Dice · автоматический бэкап\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="disable_notification"\r\n\r\ntrue\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\n`
        + 'Content-Type: application/json\r\n\r\n',
      ),
      Buffer.from(json, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.fetch(`${this.apiBase}/bot${this.botToken}/sendDocument`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`sendDocument: ${data.description || `HTTP ${response.status}`}`);
    }
    return data.result;
  }

  async editDocument(messageId, json) {
    const media = {
      type: 'document',
      media: `attach://${this.fileName}`,
      caption: `Path of Dice · бэкап ${new Date(this.now()).toISOString()}`,
    };
    const boundary = `----pathofdiceEdit${this.now()}${Math.floor(Math.random() * 1e6)}`;
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${this.chatId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="message_id"\r\n\r\n${messageId}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="media"\r\n\r\n${JSON.stringify(media)}\r\n`),
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${this.fileName}"; filename="${this.fileName}"\r\n`
        + 'Content-Type: application/json\r\n\r\n',
      ),
      Buffer.from(json, 'utf8'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.fetch(`${this.apiBase}/bot${this.botToken}/editMessageMedia`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) {
      throw new Error(`editMessageMedia: ${data.description || `HTTP ${response.status}`}`);
    }
    return data.result;
  }

  /** Загружает текущую БД в Telegram Cloud (сериализованный вызов). */
  async backupNow() {
    if (!this.enabled) return { ok: false, reason: 'disabled' };
    if (!this.store?.db) return { ok: false, reason: 'no-db' };

    this.queue = this.queue.then(() => this.#doBackup()).catch((error) => {
      this.lastError = error.message;
      this.log(`[cloud] backup error: ${error.message}`);
      return { ok: false, reason: error.message };
    });
    return this.queue;
  }

  async #doBackup() {
    const json = JSON.stringify({
      ...this.store.db,
      meta: { ...this.store.db.meta, cloudSavedAt: this.now(), generation: (this.store.db.meta?.generation || 1) + 1 },
    });
    const hash = sha256(json);
    if (hash === this.lastUploadHash) return { ok: true, skipped: true, hash };

    let result = null;
    let usedEdit = false;
    if (this.state.messageId) {
      try {
        result = await this.editDocument(this.state.messageId, json);
        usedEdit = true;
      } catch (error) {
        this.log(`[cloud] edit не удался (${error.message}) — пересоздаю сообщение.`);
        this.writeState({ messageId: null, fileId: null });
      }
    }

    if (!usedEdit) {
      result = await this.sendDocument(json);
      const messageId = result?.message_id;
      try {
        await this.call('pinChatMessage', {
          chat_id: this.chatId,
          message_id: messageId,
          disable_notification: true,
        });
      } catch (error) {
        this.log(`[cloud] pin не удался: ${error.message}`);
      }
      this.writeState({ messageId, fileId: result?.document?.file_id || null, chatId: this.chatId });
    }

    const document = result?.document || result?.document?.document || null;
    this.writeState({
      messageId: result?.message_id || this.state.messageId,
      fileId: document?.file_id || this.state.fileId,
      hash,
      bytes: json.length,
    });
    this.lastUploadHash = hash;
    this.lastUploadAt = this.now();
    this.lastError = null;
    this.log(`[cloud] ☁️ Бэкап загружен (${Math.round(json.length / 1024)} КБ, hash ${hash}).`);
    return { ok: true, hash, bytes: json.length };
  }

  status() {
    return {
      enabled: this.enabled,
      chatId: this.chatId ? `***${String(this.chatId).slice(-4)}` : null,
      messageId: this.state.messageId,
      fileId: this.state.fileId ? `***${String(this.state.fileId).slice(-8)}` : null,
      lastUploadAt: this.lastUploadAt,
      lastError: this.lastError,
      hash: this.lastUploadHash,
    };
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Создаёт облачный бэкап и (если возможно) восстанавливает БД при старте.
 * @returns {Promise<{backup:CloudBackup|null, restored:boolean, db:object|null}>}
 */
export async function restoreDbFromTelegramCloud({
  store,
  botToken = process.env.BOT_TOKEN,
  adminId = process.env.ADMIN_ID,
  statePath = process.env.CLOUD_STATE_PATH || path.join(process.cwd(), 'data', 'cloud-state.json'),
  log = console.log,
  attachStore = true,
} = {}) {
  if (!botToken || !adminId) {
    log('[cloud] Telegram Cloud бэкап выключен: нет BOT_TOKEN/ADMIN_ID.');
    return { backup: null, restored: false, db: null };
  }
  const backup = new CloudBackup({ store, botToken, chatId: adminId, statePath, log });
  const db = await backup.restore();
  if (db) {
    if (store && attachStore) store.adopt(db);
    if (store && attachStore) store.flushSync();
    return { backup, restored: true, db };
  }
  return { backup, restored: false, db: null };
}

export { DEFAULT_FILE_NAME, DEBOUNCE_MS, sha256 };
