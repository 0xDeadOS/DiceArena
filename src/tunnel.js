/**
 * PATH OF DICE — src/tunnel.js
 * Авто-поднятие бесплатного HTTPS-туннеля для локальной разработки.
 * Порядок попыток: cloudflared → localhost.run (ssh). Никаких платных сервисов.
 */

import { spawn } from 'node:child_process';

const URL_PATTERNS = [
  /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
  /(https:\/\/[a-z0-9-]+\.lhr\.life)/i,
  /(https:\/\/[a-z0-9-]+\.localhost\.run)/i,
  /(https:\/\/[a-z0-9-]+\.ngrok-free\.app)/i,
  /(https:\/\/[a-z0-9.-]+\.onrender\.com)/i,
];

export function extractUrl(text = '') {
  for (const pattern of URL_PATTERNS) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

/**
 * Пытается поднять туннель одной командой. Возвращает управляемый объект.
 */
export function spawnTunnel({ command, args, port, timeoutMs = 30000, log = console.log }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, reason: error.message });
      return;
    }

    let buffer = '';
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };

    const onData = (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 20000) buffer = buffer.slice(-10000);
      const url = extractUrl(buffer);
      if (url) {
        log(`[tunnel] 🔗 HTTPS: ${url}`);
        finish({
          ok: true,
          url,
          port,
          command,
          close: () => {
            try {
              child.kill('SIGTERM');
            } catch {
              /* уже мёртв */
            }
          },
        });
      }
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (error) => finish({ ok: false, reason: error.message }));
    child.on('close', (code) => finish({ ok: false, reason: `${command} завершился с кодом ${code}`, output: buffer.slice(-800) }));

    const timer = setTimeout(() => finish({ ok: false, reason: `${command}: таймаут ${timeoutMs} мс`, output: buffer.slice(-800) }), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

/**
 * Поднимает туннель, перебирая доступные бесплатные провайдеры.
 * @returns {Promise<{ok:boolean, url?:string, provider?:string, close?:Function, reason?:string}>}
 */
export async function startTunnel({ port = process.env.PORT || 3000, log = console.log, timeoutMs = 30000 } = {}) {
  const attempts = [];

  if (await commandExists('cloudflared')) {
    attempts.push({
      provider: 'cloudflared',
      run: () => spawnTunnel({
        command: 'cloudflared',
        args: ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
        port,
        timeoutMs,
        log,
      }),
    });
  }

  if (await commandExists('ssh')) {
    attempts.push({
      provider: 'localhost.run',
      run: () => spawnTunnel({
        command: 'ssh',
        args: [
          '-o', 'StrictHostKeyChecking=no',
          '-o', 'UserKnownHostsFile=/dev/null',
          '-o', 'ServerAliveInterval=30',
          '-R', `80:localhost:${port}`,
          'nokey@localhost.run',
        ],
        port,
        timeoutMs,
        log,
      }),
    });
  }

  if (!attempts.length) {
    log('[tunnel] cloudflared и ssh недоступны — туннель не поднят. Используйте WEBAPP_URL вручную.');
    return { ok: false, reason: 'Нет доступных туннельных утилит (cloudflared/ssh).' };
  }

  for (const attempt of attempts) {
    log(`[tunnel] пробую ${attempt.provider}…`);
    const result = await attempt.run();
    if (result.ok) return { ...result, provider: attempt.provider };
    log(`[tunnel] ${attempt.provider} не сработал: ${result.reason}`);
  }
  return { ok: false, reason: 'Все бесплатные туннели недоступны.' };
}

/** Клиент для автозапуска: включается переменной TUNNEL=1. */
export function maybeStartTunnel({ enabled = process.env.TUNNEL === '1', port, log = console.log } = {}) {
  if (!enabled) return Promise.resolve({ ok: false, reason: 'TUNNEL выключен.' });
  return startTunnel({ port, log });
}

export { commandExists };
