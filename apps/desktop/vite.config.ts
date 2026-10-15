import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

const workspace = (path: string): string =>
  fileURLToPath(new URL(`../../packages/${path}/src/index.ts`, import.meta.url));

export default defineConfig({
  plugins: [react()],
  root: fileURLToPath(new URL('./src', import.meta.url)),
  publicDir: fileURLToPath(new URL('./public', import.meta.url)),
  resolve: {
    alias: {
      '@adnota/core': workspace('core'),
      '@adnota/scene': workspace('scene'),
      '@adnota/collab': workspace('collab'),
      // `@adnota/view` and `@adnota/editor` are deliberately *not* aliased. An alias
      // for `@adnota/view` points at its `index.ts`, which would then swallow
      // `@adnota/view/styles.css` into a path inside a file rather than resolving it
      // through the package's own `exports` map. Node-style resolution handles both
      // correctly, which is why the browser harness does the same.
    },
  },
  server: {
    // Deliberately not 5173. The browser harness owns that port, and being able to run
    // `pnpm dev:web` alongside `pnpm desktop:dev` is worth more than the tidiness of a
    // shared one — comparing the two is how you check that the persistence layer has
    // not changed what the app does.
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
