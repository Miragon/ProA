import { createRoute } from '@hono/zod-openapi';
import { OPENAPI_PATH, apiRoutes, buildOpenApiDocument, type Health } from '@proa/contracts';

import type { DemoConfig } from '../../config.ts';
import type { Database } from '../../db/client.ts';
import type { App } from '../context.ts';

export interface SystemRouteDeps {
  database: Pick<Database, 'ping'>;
  version: string;
  /**
   * The read-only demo (`PROA_DEMO=readonly`): health says so, with the
   * operator's legal links when set, for the web UI. Absent in local mode.
   */
  demo?: Pick<DemoConfig, 'imprintUrl' | 'privacyUrl'> | null;
}

/**
 * `GET /health` (200 ok / 503 database down; `demo: "readonly"` and the
 * operator's legal links only on the read-only demo, so local mode answers
 * as before) and `GET /api/v1/openapi.json`.
 */
export function registerSystemRoutes(app: App, deps: SystemRouteDeps): void {
  app.openapi(createRoute(apiRoutes.getHealth), async (c) => {
    const up = await deps.database.ping();
    const body: Health = {
      status: up ? 'ok' : 'degraded',
      version: deps.version,
      db: up ? 'ok' : 'down',
      ...(deps.demo ? demoHealth(deps.demo) : {}),
    };
    return up ? c.json(body, 200) : c.json(body, 503);
  });

  // One source of truth: the document comes from @proa/contracts, not from
  // the routes registered here (test/unit/app.test.ts checks they match).
  const document = buildOpenApiDocument({ version: deps.version });
  app.get(OPENAPI_PATH, (c) => c.json(document));
}

/** The demo's part of {@link Health}: the flag, then each legal link that is set. */
function demoHealth(demo: Pick<DemoConfig, 'imprintUrl' | 'privacyUrl'>): Partial<Health> {
  return {
    demo: 'readonly',
    ...(demo.imprintUrl === undefined ? {} : { imprintUrl: demo.imprintUrl }),
    ...(demo.privacyUrl === undefined ? {} : { privacyUrl: demo.privacyUrl }),
  };
}
