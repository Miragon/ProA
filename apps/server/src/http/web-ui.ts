import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { serveStatic } from '@hono/node-server/serve-static';

import type { App } from './context.ts';

/**
 * Paths that never fall back to the web UI: unknown API, MCP and well-known
 * paths answer a 404 problem (CONCEPT §6: no SPA page under `/.well-known/`).
 */
export function isReservedPath(p: string): boolean {
  return (
    p === '/api' ||
    p.startsWith('/api/') ||
    p === '/mcp' ||
    p.startsWith('/mcp/') ||
    p === '/health' ||
    p.startsWith('/.well-known/')
  );
}

/**
 * Serves the built web UI (`apps/web/dist`) for GET/HEAD: static files first,
 * then `index.html` for client-side routes. Register after all API routes.
 */
export function mountWebUi(app: App, webDist: string): void {
  const indexFile = path.join(webDist, 'index.html');
  const assets = serveStatic({ root: webDist });

  app.get('*', async (c, next) => {
    if (isReservedPath(c.req.path)) return next();
    return assets(c, next);
  });
  app.get('*', async (c, next) => {
    if (isReservedPath(c.req.path)) return next();
    const html = await readFile(indexFile, 'utf8');
    return c.html(html);
  });
}
