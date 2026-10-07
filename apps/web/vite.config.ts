import { fileURLToPath } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

/** The ProA server the dev server proxies to (apps/server, `pnpm dev`). */
const api = process.env['PROA_URL'] ?? 'http://127.0.0.1:7400';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  // Dev: http://127.0.0.1:7401 with API, MCP and health proxied to the server.
  // Production: `vite build` → dist/, served by the server (PROA_WEB_DIST).
  server: {
    host: '127.0.0.1',
    port: 7401,
    strictPort: true,
    proxy: { '/api': api, '/mcp': api, '/health': api },
  },
  preview: { host: '127.0.0.1', port: 7401, strictPort: true },
  build: {
    // bpmn-js is loaded lazily with the model view and is one large chunk on its own.
    chunkSizeWarningLimit: 1200,
  },
  // Component tests (Testing Library on jsdom). The Playwright smoke test in e2e/ runs separately.
  test: {
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['test/setup.ts'],
    css: false,
  },
});
