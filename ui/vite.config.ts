import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Dev: Vite serves the UI with HMR and proxies /api + /ws to the Bun backend.
// Prod: `vite build` → ui/dist, served by Bun (serveStatic in src/server/index.ts).
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5174,
    proxy: {
      '/api': 'http://localhost:3333',
      '/ws': { target: 'ws://localhost:3333', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
