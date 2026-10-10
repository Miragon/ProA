import { createRoute } from '@hono/zod-openapi';
import { OPENAPI_PATH, apiRoutes, buildOpenApiDocument, type Health } from '@proa/contracts';

import type { Database } from '../../db/client.ts';
import type { App } from '../context.ts';

export interface SystemRouteDeps {
  database: Pick<Database, 'ping'>;
  version: string;
  /** The read-only demo (`PROA_DEMO=readonly`): health says so, for the web UI. */
  demo?: boolean;
}

/**
 * `GET /health` (200 ok / 503 database down; `demo: "readonly"` only on the
 * read-only demo) and `GET /api/v1/openapi.json`.
 */
export function registerSystemRoutes(app: App, deps: SystemRouteDeps): void {
  app.openapi(createRoute(apiRoutes.getHealth), async (c) => {
    const up = await deps.database.ping();
    const body: Health = {
      status: up ? 'ok' : 'degraded',
      version: deps.version,
      db: up ? 'ok' : 'down',
      ...(deps.demo ? { demo: 'readonly' as const } : {}),
    };
    return up ? c.json(body, 200) : c.json(body, 503);
  });

  // One source of truth: the document comes from @proa/contracts, not from
  // the routes registered here (test/unit/app.test.ts checks they match).
  const document = buildOpenApiDocument({ version: deps.version });
  app.get(OPENAPI_PATH, (c) => c.json(document));
}
