import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      '@dicebound/shared-types': fileURLToPath(
        new URL('./packages/shared-types/src/index.ts', import.meta.url),
      ),
      '@dicebound/game-core': fileURLToPath(
        new URL('./packages/game-core/src/index.ts', import.meta.url),
      ),
      '@dicebound/db': fileURLToPath(new URL('./packages/db/src/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/*.integration.test.ts'],
    environment: 'node',
    restoreMocks: true,
  },
});
