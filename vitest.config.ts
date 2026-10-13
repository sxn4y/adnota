import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const resolve = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@adnota/core': resolve('./packages/core/src/index.ts'),
      '@adnota/scene': resolve('./packages/scene/src/index.ts'),
      '@adnota/collab': resolve('./packages/collab/src/index.ts'),
      '@adnota/editor': resolve('./packages/editor/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['packages/**/*.test.ts', 'apps/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**/*.ts'],
    },
  },
});
