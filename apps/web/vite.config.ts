import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * Общие пакеты резолвятся на исходники, а не на `dist/`. Без этого обзор интерфейса
 * не запускается на свежем клоне: `exports` пакетов указывает на `dist/index.js`,
 * которого нет до сборки сервера, и Vite падает с «Failed to resolve entry for package».
 * Тот же приём уже используется в `vitest.config.ts`.
 */
const source = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../..', '');
  return {
    plugins: [react()],
    envDir: '../..',
    resolve: {
      alias: {
        '@dicebound/shared-types': source('shared-types'),
        '@dicebound/game-core': source('game-core'),
      },
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
      strictPort: true,
      allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'],
      proxy: {
        '/api': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:3001', changeOrigin: true },
      },
    },
    preview: { host: '0.0.0.0', allowedHosts: ['.e2b.app', 'localhost', '127.0.0.1'] },
  };
});
