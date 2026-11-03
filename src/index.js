/**
 * PATH OF DICE — src/index.js
 * Express-сервер: GZIP-сжатие, статика Web Mini App, REST API, keep-alive пинг,
 * восстановление БД из Telegram Cloud и graceful shutdown.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import dotenv from 'dotenv';
import express from 'express';

import {
  buildSignedLink,
  createAuthMiddleware,
  requireAdmin,
  requirePlayer,
  signToken,
  validateInitData,
  verifySignedLink,
  verifyToken,
  getSecret,
} from './auth.js';
import { CloudBackup, restoreDbFromTelegramCloud } from './cloudStorage.js';
import { createBot, getWebAppUrl } from './bot.js';
import { GameStore } from './store.js';
import { maybeStartTunnel } from './tunnel.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

export const KEEP_ALIVE_INTERVAL_MS = 14 * 60 * 1000; // Render усыпляет после 15 минут простоя

/* ─────────────────────────── GZIP ─────────────────────────── */

const COMPRESSIBLE = /^(text\/|application\/(json|javascript|xml|manifest\+json)|image\/svg)/;

/** Ручной gzip-middleware — без внешних зависимостей. */
export function gzipMiddleware({ threshold = 1024, level = 6 } = {}) {
  return function gzip(req, res, next) {
    const accept = req.headers['accept-encoding'] || '';
    if (!/\bgzip\b/.test(accept) || req.method === 'HEAD') return next();

    const originalSend = res.send.bind(res);
    const originalJson = res.json.bind(res);

    const shouldCompress = (body) => {
      if (res.getHeader('content-encoding')) return false;
      if (!COMPRESSIBLE.test(String(res.getHeader('content-type') || ''))) return false;
      const length = Buffer.byteLength(body);
      return length >= threshold;
    };

    const compressAndSend = (body) => {
      if (!shouldCompress(body)) return originalSend(body);
      const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
      zlib.gzip(buffer, { level }, (error, zipped) => {
        if (error) return originalSend(body);
        res.setHeader('Content-Encoding', 'gzip');
        res.setHeader('Vary', 'Accept-Encoding');
        res.setHeader('Content-Length', zipped.length);
        res.end(zipped);
      });
      return res;
    };

    res.json = (payload) => {
      const json = JSON.stringify(payload);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      if (!shouldCompress(json)) return originalSend(json);
      return compressAndSend(json);
    };
    res.send = (body) => {
      if (body === undefined || typeof body === 'object') return originalSend(body);
      return compressAndSend(body);
    };
    next();
  };
}

/* ─────────────────────────── Ответы ─────────────────────────── */

function ok(res, payload = {}) {
  res.json({ ok: true, ...payload });
}

function fail(res, status, reason) {
  res.status(status).json({ ok: false, reason });
}

/** Оборачивает обработчик, чтобы ошибки не роняли процесс. */
function wrap(handler) {
  return (req, res, next) => {
    try {
      const result = handler(req, res);
      if (result && typeof result.catch === 'function') result.catch(next);
    } catch (error) {
      next(error);
    }
  };
}

/* ─────────────────────────── App ─────────────────────────── */

/**
 * Создаёт Express-приложение. Не слушает порт — это делает startServer().
 * @param {object} opts
 * @param {GameStore} [opts.store]
 * @param {string} [opts.publicDir]
 * @param {CloudBackup} [opts.cloud]
 */
export function createApp({
  store = new GameStore(),
  publicDir = PUBLIC_DIR,
  cloud = null,
  log = console.log,
  allowDevAuth = process.env.ALLOW_DEV_AUTH !== 'false',
} = {}) {
  if (!store.db) store.load();

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(express.json({ limit: '256kb' }));
  app.use(gzipMiddleware());
  app.use(createAuthMiddleware(store, { allowDevAuth }));

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    // Mini App работает внутри iframe Telegram — запрещать фрейминг нельзя.
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    next();
  });

  /* ── Health & keep-alive ── */
  app.get('/health', (req, res) => {
    res.json({
      ok: true,
      status: 'healthy',
      uptime: Math.round(process.uptime()),
      node: process.version,
      store: store.healthInfo(),
      cloud: cloud ? cloud.status() : { enabled: false },
      bot: Boolean(process.env.BOT_TOKEN),
      webAppUrl: getWebAppUrl(),
      time: new Date().toISOString(),
    });
  });

  app.get('/healthz', (req, res) => res.type('text/plain').send('ok'));

  /* ── Авторизация ── */
  app.post('/api/auth/session', wrap((req, res) => {
    const { initData, playerId, sig, guest } = req.body || {};

    // 1) Telegram initData
    if (initData) {
      const check = validateInitData(initData);
      if (!check.ok) {
        return fail(res, 401, `Telegram initData отклонён: ${check.reason}`);
      }
      const { player, created, linked } = store.ensureTelegramPlayer(check.user);
      const adminTelegram = process.env.ADMIN_ID ? String(process.env.ADMIN_ID) : null;
      if (adminTelegram && String(player.telegramId) === adminTelegram) player.isAdmin = true;
      const token = signToken({
        playerId: player.id,
        telegramId: player.telegramId,
        admin: store.isAdmin(player),
      });
      store.touch();
      return ok(res, {
        token,
        playerId: player.id,
        player: store.publicPlayer(player, { self: true }),
        created,
        linked,
        source: 'telegram',
        admin: store.isAdmin(player),
      });
    }

    // 2) Подписанная ссылка ?player=&sig=
    if (playerId && sig) {
      const check = verifySignedLink({ playerId, sig });
      if (!check.ok) return fail(res, 401, check.reason);
      const player = store.getPlayer(check.playerId);
      if (!player) return fail(res, 404, 'Игрок не найден.');
      const token = signToken({
        playerId: player.id,
        telegramId: player.telegramId,
        admin: store.isAdmin(player),
      });
      store.touchPlayer(player);
      return ok(res, {
        token,
        playerId: player.id,
        player: store.publicPlayer(player, { self: true }),
        source: 'signed-link',
        admin: store.isAdmin(player),
      });
    }

    // 3) Прямой токен
    if (req.body?.token) {
      const check = verifyToken(req.body.token);
      if (!check.ok) return fail(res, 401, check.reason);
      const player = store.getPlayer(check.payload.sub);
      if (!player) return fail(res, 404, 'Игрок не найден.');
      return ok(res, {
        token: req.body.token,
        playerId: player.id,
        player: store.publicPlayer(player, { self: true }),
        source: 'token',
        admin: store.isAdmin(player),
      });
    }

    // 4) Гость / локальная разработка
    if (guest !== false && allowDevAuth) {
      const fallback = store.db.players[0];
      if (!fallback) return fail(res, 500, 'В базе нет игроков.');
      const token = signToken({ playerId: fallback.id, telegramId: fallback.telegramId, admin: store.isAdmin(fallback) });
      return ok(res, {
        token,
        playerId: fallback.id,
        player: store.publicPlayer(fallback, { self: true }),
        source: 'dev-fallback',
        admin: store.isAdmin(fallback),
        readOnly: false,
        notice: 'Гостевой вход: выберите профиль друга в шапке. На localhost это безопасно.',
      });
    }

    return fail(res, 401, 'Не удалось авторизоваться. Откройте приложение через Telegram-бота (/start).');
  }));

  app.get('/api/auth/me', wrap((req, res) => {
    const player = req.auth?.player;
    if (!player) return ok(res, { player: null, guest: true, reason: req.auth?.reason || null });
    return ok(res, {
      player: store.publicPlayer(player, { self: true }),
      admin: store.isAdmin(player),
      source: req.auth.source,
      token: req.auth.token,
      webAppUrl: getWebAppUrl(),
    });
  }));

  /** Список профилей для локального переключателя. */
  app.get('/api/profiles', wrap((req, res) => {
    ok(res, {
      profiles: store.db.players.map((player) => ({
        id: player.id,
        name: player.name,
        nickname: player.nickname,
        avatar: player.avatar,
        role: player.role,
        isAdmin: store.isAdmin(player),
        linked: Boolean(player.telegramId),
        signLink: buildSignedLink({ playerId: player.id, baseUrl: getWebAppUrl() }),
      })),
    });
  }));

  /* ── Состояние ── */
  app.get('/api/state', wrap((req, res) => {
    const player = req.auth?.player || null;
    const since = req.query.v !== undefined ? Number(req.query.v) : null;
    const state = store.getState(player, { sinceVersion: Number.isFinite(since) ? since : null });
    if (state.unchanged) {
      return ok(res, { unchanged: true, version: store.version });
    }
    res.json({ ok: true, ...state, guest: !player });
  }));

  /* ── Игровые действия (требуют игрока) ── */
  const guarded = express.Router();

  guarded.post('/roll', requirePlayer, wrap((req, res) => {
    const player = req.auth.player;
    const result = store.roll(player);
    if (!result.ok) return fail(res, 409, result.reason);
    store.flushSync();
    return ok(res, result);
  }));

  guarded.post('/craft/orb', requirePlayer, wrap((req, res) => {
    const player = req.auth.player;
    const { dieId, orbId } = req.body || {};
    const result = store.craftOrb(player, { dieId, orbId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/craft/bench', requirePlayer, wrap((req, res) => {
    const player = req.auth.player;
    const { dieId, recipeId } = req.body || {};
    const result = store.craftBench(player, { dieId, recipeId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/inventory/equip', requirePlayer, wrap((req, res) => {
    const result = store.equipDie(req.auth.player, req.body?.dieId);
    if (!result.ok) return fail(res, 404, result.reason);
    return ok(res, result);
  }));

  guarded.post('/inventory/toggle-lock', requirePlayer, wrap((req, res) => {
    const result = store.toggleLock(req.auth.player, req.body?.dieId);
    if (!result.ok) return fail(res, 404, result.reason);
    return ok(res, result);
  }));

  guarded.post('/inventory/buy-base', requirePlayer, wrap((req, res) => {
    const result = store.buyBase(req.auth.player, req.body?.baseId);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/inventory/gamble-unique', requirePlayer, wrap((req, res) => {
    const result = store.gambleUnique(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/inventory/salvage', requirePlayer, wrap((req, res) => {
    const result = store.salvage(req.auth.player, req.body?.dieId);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/trade/transfer', requirePlayer, wrap((req, res) => {
    const { toPlayerId, orbId, amount } = req.body || {};
    const result = store.transferOrbs(req.auth.player, { toPlayerId, orbId, amount });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  /* ── Атлас: карты ── */
  guarded.post('/maps/craft', requirePlayer, wrap((req, res) => {
    const { mapId, orbId } = req.body || {};
    const result = store.craftMapOrb(req.auth.player, { mapId, orbId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/maps/buy', requirePlayer, wrap((req, res) => {
    const result = store.buyMap(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/maps/start', requirePlayer, wrap((req, res) => {
    const { mapId, partnerId } = req.body || {};
    const result = store.startMap(req.auth.player, { mapId, partnerId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  const chooseNodeHandler = wrap((req, res) => {
    const player = req.auth.player;
    const nodeId = req.body?.nodeId;
    if (!nodeId) return fail(res, 400, 'Не передан nodeId.');
    const result = store.chooseNode(player, { nodeId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  });
  guarded.post('/maps/node', requirePlayer, chooseNodeHandler);
  guarded.post('/maps/choose-node', requirePlayer, chooseNodeHandler);

  guarded.post('/maps/turn', requirePlayer, wrap((req, res) => {
    const { action, orbId } = req.body || {};
    const result = store.mapTurn(req.auth.player, { action: action || 'attack', orbId: orbId || null });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/maps/retreat', requirePlayer, wrap((req, res) => {
    const result = store.retreat(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/maps/dismiss', requirePlayer, wrap((req, res) => {
    const result = store.dismiss(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/maps/run', requirePlayer, wrap((req, res) => {
    const { mapId, partnerId, auto } = req.body || {};
    const result = auto === false
      ? store.startMap(req.auth.player, { mapId, partnerId })
      : store.autoRun(req.auth.player, { mapId, partnerId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  /* ── Атлас: дерево и фрагменты ── */
  guarded.post('/atlas/point', requirePlayer, wrap((req, res) => {
    const result = store.learnAtlasPassive(req.auth.player, req.body?.passiveId);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/atlas/deposit', requirePlayer, wrap((req, res) => {
    const result = store.depositFragment(req.auth.player, req.body?.fragmentId);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  /* ── Рейд ── */
  guarded.post('/raid/summon', requirePlayer, wrap((req, res) => {
    const result = store.summonRaid(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/raid/attack', requirePlayer, wrap((req, res) => {
    const result = store.raidAttack(req.auth.player);
    if (!result.ok) return fail(res, 429, result.reason);
    return ok(res, result);
  }));

  guarded.post('/raid/claim', requirePlayer, wrap((req, res) => {
    const result = store.raidClaim(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/raid/roll-loot', requirePlayer, wrap((req, res) => {
    const result = store.raidRollLoot(req.auth.player);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  /* ── Задания и дуэли ── */
  guarded.post('/quest/claim', requirePlayer, wrap((req, res) => {
    const result = store.claimQuest(req.auth.player, req.body?.questId);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.post('/duel', requirePlayer, wrap((req, res) => {
    const result = store.duel(req.auth.player, { opponentId: req.body?.opponentId });
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  guarded.get('/me', requirePlayer, wrap((req, res) => {
    ok(res, { player: store.publicPlayer(req.auth.player, { self: true }) });
  }));

  // Guard применяем только к зарегистрированным игровым маршрутам,
  // иначе несуществующий /api-путь отдавал бы 401 вместо 404.
  app.use('/api', (req, res, next) => next(), guarded);

  /* ── Админка ── */
  const adminGuard = requireAdmin(store);
  app.post('/api/settings/daily-limit', adminGuard, wrap((req, res) => {
    const result = store.setDailyLimit(req.auth.player, req.body?.limit);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  app.post('/api/settings/reset-cd', adminGuard, wrap((req, res) => {
    ok(res, store.resetCooldown(req.auth.player, req.body?.playerId || null));
  }));

  app.post('/api/settings/reset-boss', adminGuard, wrap((req, res) => {
    ok(res, store.resetBoss(req.auth.player));
  }));

  app.post('/api/settings/reset-ladder', adminGuard, wrap((req, res) => {
    ok(res, store.resetLadder(req.auth.player));
  }));

  app.post('/api/settings/reset-all', adminGuard, wrap((req, res) => {
    const result = store.resetAll(req.auth.player, req.body?.code);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  app.post('/api/settings/atlas', adminGuard, wrap((req, res) => {
    const { playerId, points } = req.body || {};
    const result = store.setAtlasPoints(req.auth.player, playerId, points);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  app.post('/api/settings/reset-atlas', adminGuard, wrap((req, res) => {
    const result = store.resetAtlas(req.auth.player, req.body?.playerId);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  app.post('/api/cheat/modify-orbs', adminGuard, wrap((req, res) => {
    const { playerId, orbId, delta } = req.body || {};
    const result = store.cheatOrbs(req.auth.player, playerId, orbId, delta);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  app.post('/api/cheat/add-orbs', adminGuard, wrap((req, res) => {
    const { playerId, orbId, amount } = req.body || {};
    const delta = Math.abs(Math.round(Number(amount) || 1));
    const result = store.cheatOrbs(req.auth.player, playerId, orbId, delta);
    if (!result.ok) return fail(res, 409, result.reason);
    return ok(res, result);
  }));

  /* ── Cloud backup ── */
  app.get('/api/cloud/status', adminGuard, wrap((req, res) => {
    ok(res, { cloud: cloud ? cloud.status() : { enabled: false } });
  }));

  app.post('/api/cloud/backup', adminGuard, wrap(async (req, res) => {
    if (!cloud) return fail(res, 503, 'Облачный бэкап не настроен.');
    const result = await cloud.backupNow();
    return ok(res, result);
  }));

  app.post('/api/cloud/restore', adminGuard, wrap(async (req, res) => {
    if (!cloud) return fail(res, 503, 'Облачный бэкап не настроен.');
    const db = await cloud.restore();
    if (!db) return fail(res, 404, 'Слепок в Telegram не найден.');
    store.adopt(db);
    store.flushSync();
    return ok(res, { restored: true, players: store.db.players.length });
  }));

  /* ── Статика ── */
  app.use(express.static(publicDir, {
    etag: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
    extensions: ['html'],
  }));

  app.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  app.all('/api/*', (req, res) => fail(res, 404, `Эндпоинт ${req.method} ${req.path} не найден.`));

  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) {
      return res.sendFile(path.join(publicDir, 'index.html'));
    }
    return next();
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, _next) => {
    log(`[http] ${req.method} ${req.path}: ${error.message}`);
    const status = error.status || 500;
    res.status(status).json({ ok: false, reason: error.message || 'Внутренняя ошибка сервера.' });
  });

  app.locals.store = store;
  app.locals.cloud = cloud;
  return app;
}

/* ─────────────────────────── Keep-alive ─────────────────────────── */

export function startKeepAlive({ url = process.env.KEEP_ALIVE_URL, intervalMs = KEEP_ALIVE_INTERVAL_MS, log = console.log } = {}) {
  if (!url) {
    log('[keep-alive] KEEP_ALIVE_URL не задан — пинг выключен.');
    return null;
  }
  const target = url.replace(/\/$/, '') + '/health';
  const ping = async () => {
    try {
      const response = await fetch(target, { signal: AbortSignal.timeout(10000) });
      log(`[keep-alive] ${target} → ${response.status}`);
    } catch (error) {
      log(`[keep-alive] ${target} ошибка: ${error.message}`);
    }
  };
  const timer = setInterval(ping, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  setTimeout(ping, 5000).unref?.();
  return timer;
}

/* ─────────────────────────── Bootstrap ─────────────────────────── */

export async function startServer({
  port = Number(process.env.PORT) || 3000,
  host = process.env.HOST || '0.0.0.0',
  store = new GameStore(),
  log = console.log,
  startBot = process.env.START_BOT !== 'false',
  enableCloud = process.env.CLOUD_BACKUP !== 'false',
  enableTunnel = process.env.TUNNEL === '1',
} = {}) {
  store.load();

  const { backup, restored } = enableCloud
    ? await restoreDbFromTelegramCloud({
      store,
      botToken: process.env.BOT_TOKEN,
      adminId: process.env.ADMIN_ID,
      log,
    })
    : { backup: null, restored: false };

  if (backup) {
    const originalFlushHook = store.onSave;
    store.onSave = (db, version) => {
      if (typeof originalFlushHook === 'function') originalFlushHook(db, version);
      backup.schedule();
    };
  }

  const app = createApp({ store, cloud: backup, log });
  const server = await new Promise((resolve) => {
    const s = app.listen(port, host, () => resolve(s));
  });
  const actualPort = server.address().port;

  log('──────────────────────────────────────────────');
  log(' 🎲 PATH OF DICE — Кубик Изгнанника');
  log(` ▶ http://localhost:${actualPort}`);
  log(` ▶ DB: ${store.dbPath}`);
  log(` ▶ Telegram Cloud: ${backup ? 'включён' : 'выключен'}`);
  log(` ▶ восстановление из облака: ${restored ? 'ДА' : 'нет'}`);
  log('──────────────────────────────────────────────');

  if (enableTunnel) {
    maybeStartTunnel({ enabled: true, port: actualPort, log }).then((tunnel) => {
      if (tunnel.ok) {
        log(`[tunnel] Откройте Mini App: ${tunnel.url}`);
        if (!process.env.WEBAPP_URL) process.env.WEBAPP_URL = tunnel.url;
      }
    });
  }

  let bot = null;
  if (startBot && process.env.BOT_TOKEN) {
    try {
      bot = createBot({ store, log });
      if (bot) {
        bot.api.setMyCommands([
          { command: 'start', description: 'Карточка кубика и вход в игру' },
          { command: 'help', description: 'Справка по игре' },
          { command: 'web', description: 'Персональная ссылка в Mini App' },
        ]).catch(() => {});
        bot.start({
          drop_pending_updates: true,
          onStart: (info) => log(`[bot] @${info.username} принимает /start /help /web`),
        }).catch((error) => log(`[bot] ошибка polling: ${error.message}`));
      }
    } catch (error) {
      log(`[bot] не запущен: ${error.message}`);
    }
  }

  const keepAlive = startKeepAlive({ log });

  const shutdown = async (signal) => {
    log(`\n[server] ${signal}: сохраняю БД и завершаюсь…`);
    clearInterval(keepAlive);
    if (backup) {
      backup.stop();
      try {
        await backup.backupNow();
      } catch (error) {
        log(`[cloud] финальный бэкап не удался: ${error.message}`);
      }
    }
    store.shutdown();
    try {
      if (bot) await bot.stop();
    } catch {
      /* уже остановлен */
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => log(`[server] unhandledRejection: ${reason}`));
  process.on('uncaughtException', (error) => log(`[server] uncaughtException: ${error.message}`));

  return { app, server, store, backup, port: actualPort };
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  dotenv.config();
  getSecret();
  startServer().catch((error) => {
    console.error('[server] Фатальная ошибка:', error);
    process.exitCode = 1;
  });
}

export { createApp as default };
