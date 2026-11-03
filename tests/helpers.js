/**
 * PATH OF DICE — tests/helpers.js
 * Общие утилиты для автотестов: сборка изолированного GameStore (без диска),
 * быстрый игрок, HTTP-клиент к реальному Express-приложению и детерминированный RNG.
 */

import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GameStore } from '../src/store.js';
import { createApp } from '../src/index.js';
import { createRng } from '../src/engine/crafting.js';

/** Детерминированный RNG для воспроизводимых тестов. */
export function seeded(seed = 42) {
  return createRng(seed);
}

/** Стор без записи на диск (persist=false) и без шума в консоли. */
export function makeStore({ seed } = {}) {
  const store = new GameStore({
    persist: false,
    quiet: true,
    now: () => 1767225600000,
  });
  store.load();
  if (seed) store.rng = seed;
  return store;
}

/** Стор с реальным временем — для тестов кулдаунов и наград. */
export function makeLiveStore() {
  const store = new GameStore({ persist: false, quiet: true });
  store.load();
  return store;
}

/** Полный набор сфер у игрока — чтобы тесты не зависели от дропа. */
export function fillInventory(store, player, amount = 60) {
  for (const orbId of Object.keys(player.inventory)) {
    player.inventory[orbId] = amount;
  }
  return player;
}

export function tmpDbPath(name = 'db') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-of-dice-'));
  return path.join(dir, `${name}.json`);
}

/**
 * Поднимает реальный HTTP-сервер приложения на случайном порту.
 * @returns {Promise<{baseUrl:string, close:Function, app:object, store:GameStore, api:Function}>}
 */
export async function startTestServer({ store = makeStore() } = {}) {
  const app = createApp({ store, allowDevAuth: true, log: () => {} });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  const api = async (method, urlPath, { body, token, headers = {} } = {}) => {
    const response = await fetch(`${baseUrl}${urlPath}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = { raw: text };
    }
    return { status: response.status, headers: response.headers, data: json };
  };

  const close = async () => {
    server.close();
    await once(server, 'close');
  };

  return { baseUrl, close, app, store, server, api };
}

/** Логин тестового игрока через dev-фолбэк. */
export async function login(api, playerId = null) {
  const body = playerId
    ? { playerId, sig: null }
    : {};
  if (playerId) {
    // Для подписанной ссылки нужен sig — берём через /api/profiles.
    const profiles = await api('GET', '/api/profiles');
    const entry = profiles.data.profiles.find((p) => p.id === playerId) || profiles.data.profiles[0];
    const sig = new URL(entry.signLink).searchParams.get('sig');
    const session = await api('POST', '/api/auth/session', { body: { playerId: entry.id, sig } });
    return session.data;
  }
  const session = await api('POST', '/api/auth/session', { body });
  return session.data;
}

export function assertOk(t, payload, label = 'ответ') {
  if (!payload?.ok) {
    t.diagnostic(`${label}: ${JSON.stringify(payload).slice(0, 400)}`);
  }
  return payload?.ok;
}

export function countMods(die) {
  return (die?.mods || []).length;
}

export { createRng };
