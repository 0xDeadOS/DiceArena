/**
 * PATH OF DICE — src/auth.js
 * HMAC-SHA256 токены игроков, валидация Telegram WebApp initData,
 * персональные подписанные ссылки и проверка прав администратора.
 */

import crypto from 'node:crypto';

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 дней
const INIT_DATA_MAX_AGE_SEC = 24 * 60 * 60;       // сутки — защита от повторов

export function getSecret() {
  return process.env.SESSION_SECRET || 'path-of-dice-dev-secret';
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

function parseBase64url(input) {
  return Buffer.from(input, 'base64url').toString('utf8');
}

export function signHmac(payload, secret = getSecret()) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Подписывает токен игрока: base64url(JSON).hmac
 * @param {{playerId:string, telegramId?:string|number, admin?:boolean, ttlMs?:number}} opts
 */
export function signToken({
  playerId,
  telegramId = null,
  admin = false,
  ttlMs = DEFAULT_TTL_MS,
  secret = getSecret(),
  now = Date.now(),
} = {}) {
  if (!playerId) throw new Error('playerId обязателен');
  const body = {
    sub: String(playerId),
    tg: telegramId ? String(telegramId) : null,
    adm: Boolean(admin),
    iat: now,
    exp: now + ttlMs,
  };
  const encoded = base64url(JSON.stringify(body));
  return `${encoded}.${signHmac(encoded, secret)}`;
}

/**
 * Проверяет подпись и срок жизни токена.
 * @returns {{ok:true, payload:object}|{ok:false, reason:string}}
 */
export function verifyToken(token, { secret = getSecret(), now = Date.now() } = {}) {
  if (!token || typeof token !== 'string') return { ok: false, reason: 'Токен отсутствует.' };
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'Некорректный формат токена.' };
  const [encoded, signature] = parts;
  const expected = signHmac(encoded, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Неверная подпись токена.' };
  }
  let payload;
  try {
    payload = JSON.parse(parseBase64url(encoded));
  } catch {
    return { ok: false, reason: 'Токен повреждён.' };
  }
  if (!payload?.sub) return { ok: false, reason: 'В токене нет игрока.' };
  if (payload.exp && payload.exp <= now) return { ok: false, reason: 'Токен истёк.' };
  return { ok: true, payload };
}

/* ─────────────────── Telegram initData ─────────────────── */

/**
 * Валидирует строку initData из Telegram WebApp.
 * Алгоритм: secret = HMAC_SHA256("WebAppData", botToken);
 *           hash = HMAC_SHA256(secret, data_check_string)
 */
export function validateInitData(initData, {
  botToken = process.env.BOT_TOKEN,
  maxAgeSec = INIT_DATA_MAX_AGE_SEC,
  now = Date.now(),
  clockSkewSec = 60,
} = {}) {
  if (!initData || typeof initData !== 'string') {
    return { ok: false, reason: 'initData отсутствует.' };
  }
  if (!botToken) return { ok: false, reason: 'BOT_TOKEN не настроен на сервере.' };

  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'В initData нет hash.' };
  params.delete('hash');

  const pairs = [...params.entries()]
    .map(([key, value]) => `${key}=${value}`)
    .sort();
  const dataCheckString = pairs.join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const computed = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  const hashBuf = Buffer.from(hash, 'hex');
  const computedBuf = Buffer.from(computed, 'hex');
  if (hashBuf.length !== computedBuf.length || !crypto.timingSafeEqual(hashBuf, computedBuf)) {
    return { ok: false, reason: 'Подпись initData неверна.' };
  }

  const authDate = Number(params.get('auth_date') || 0);
  if (authDate) {
    const ageSec = Math.floor(now / 1000) - authDate;
    if (ageSec > maxAgeSec) return { ok: false, reason: 'initData просрочен.' };
    if (ageSec < -clockSkewSec) return { ok: false, reason: 'initData из будущего.' };
  }

  let user = null;
  if (params.get('user')) {
    try {
      user = JSON.parse(params.get('user'));
    } catch {
      return { ok: false, reason: 'Некорректный JSON пользователя.' };
    }
  }
  if (!user?.id) return { ok: false, reason: 'В initData нет пользователя.' };

  return { ok: true, user, authDate, params: Object.fromEntries(params.entries()) };
}

/** Ссылка для входа: ?player=p1&sig=<hmac(playerId)> */
export function buildSignedLink({ playerId, baseUrl = '', secret = getSecret() }) {
  const sig = signHmac(`player:${playerId}`, secret);
  const url = new URL(baseUrl || 'http://localhost:3000');
  url.searchParams.set('player', playerId);
  url.searchParams.set('sig', sig);
  return `${url.origin}${url.pathname === '/' ? '/' : '/'}${url.search}`;
}

/** Проверяет подпись персональной ссылки. */
export function verifySignedLink({ playerId, sig, secret = getSecret() }) {
  if (!playerId || !sig) return { ok: false, reason: 'Нужны player и sig.' };
  const expected = signHmac(`player:${playerId}`, secret);
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: 'Неверная подпись ссылки.' };
  }
  return { ok: true, playerId: String(playerId) };
}

/**
 * Telegram принимает web_app-кнопки только с HTTPS.
 * Для локальной разработки оставляем возможность включить http через
 * TELEGRAM_ALLOW_HTTP=1, но по умолчанию http не пропускаем.
 */
export function isUrlTelegramSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return true;
    if (parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return false;
    return process.env.TELEGRAM_ALLOW_HTTP === '1';
  } catch {
    return false;
  }
}

/**
 * Middleware: разбирает токен из Authorization / cookie / query и кладёт игрока в req.
 * Работает в связке с GameStore — сам по себе игру не знает.
 */
export function createAuthMiddleware(store, { allowDevAuth = process.env.ALLOW_DEV_AUTH !== 'false' } = {}) {
  return function attachPlayer(req, _res, next) {
    req.auth = { player: null, token: null, source: null, guest: true };
    try {
      const header = req.get('authorization') || '';
      const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
      const cookieToken = parseCookie(req.get('cookie') || '').pod_token;
      const queryToken = typeof req.query?.token === 'string' ? req.query.token : null;
      const token = bearer || cookieToken || queryToken;

      if (token) {
        const check = verifyToken(token);
        if (check.ok) {
          const player = store.getPlayer(check.payload.sub);
          if (player) {
            req.auth = { player, token, source: 'token', guest: false };
            store.touchPlayer(player);
            return next();
          }
        }
      }

      // Подписанная ссылка (используется ботом и для локальных тестов).
      const { player: playerId, sig } = req.query || {};
      if (typeof playerId === 'string' && typeof sig === 'string') {
        const check = verifySignedLink({ playerId, sig });
        if (check.ok) {
          const player = store.getPlayer(check.playerId);
          if (player) {
            req.auth = {
              player,
              token: signToken({ playerId: player.id, telegramId: player.telegramId, admin: store.isAdmin(player) }),
              source: 'signed-link',
              guest: false,
            };
            store.touchPlayer(player);
            return next();
          }
          req.auth.reason = 'Игрок из ссылки не найден.';
          return next();
        }
        req.auth.reason = check.reason;
      }

      // Dev-auth: X-Player-Id для локальной разработки и тестов.
      const devId = req.get('x-player-id');
      if (allowDevAuth && devId) {
        const player = store.getPlayer(devId);
        if (player) {
          req.auth = {
            player,
            token: signToken({ playerId: player.id, telegramId: player.telegramId, admin: store.isAdmin(player) }),
            source: 'dev-header',
            guest: false,
          };
          store.touchPlayer(player);
          return next();
        }
        req.auth.reason = 'Игрок из X-Player-Id не найден.';
      }
    } catch (error) {
      req.auth.error = error.message;
    }
    return next();
  };
}

export function parseCookie(header) {
  const out = {};
  if (!header) return out;
  for (const chunk of header.split(';')) {
    const index = chunk.indexOf('=');
    if (index === -1) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

/** Требует авторизованного игрока. */
export function requirePlayer(req, res, next) {
  if (!req.auth?.player) {
    res.status(401).json({
      ok: false,
      reason: req.auth?.reason || 'Требуется вход через Telegram Mini App.',
      guest: true,
    });
    return;
  }
  next();
}

/** Требует администратора. */
export function requireAdmin(store) {
  return function adminGuard(req, res, next) {
    if (!req.auth?.player) {
      res.status(401).json({ ok: false, reason: 'Требуется авторизация.' });
      return;
    }
    if (!store.isAdmin(req.auth.player)) {
      res.status(403).json({ ok: false, reason: 'Только администратор чата.' });
      return;
    }
    next();
  };
}

export { DEFAULT_TTL_MS };
