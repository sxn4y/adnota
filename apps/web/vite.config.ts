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
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    sourcemap: true,
  },
});
