import { createRoute } from '@hono/zod-openapi';
import { apiRoutes } from '@proa/contracts';

import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { matchesEtag, versionEtag } from '../etag.ts';

/** `"s<seq>"`: the landscape changes exactly when the project's event seq does. */
export function landscapeEtag(seq: number): string {
  return `"s${seq}"`;
}

/** Landscape, relations and findings (CONCEPT §5). */
export function registerRelationRoutes(app: App, useCases: UseCases): void {
  app.openapi(createRoute(apiRoutes.getLandscape), async (c) => {
    const actor = requireActor(c);
    const { project } = c.req.valid('param');
    const ifNoneMatch = c.req.header('if-none-match');
    if (ifNoneMatch) {
      const { lastSeq } = await useCases.getProject(actor, project);
      const etag = landscapeEtag(lastSeq);
      if (matchesEtag(ifNoneMatch, etag)) {
        c.header('etag', etag);
        return c.body(null, 304);
      }
    }
    const landscape = await useCases.getLandscape(actor, project);
    c.header('etag', landscapeEtag(landscape.seq));
    c.header('cache-control', 'no-cache');
    return c.json(landscape, 200);
  });

  app.openapi(createRoute(apiRoutes.listRelations), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(
      await useCases.listRelations(requireActor(c), project, c.req.valid('query')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.getRelation), async (c) => {
    const { project, relation } = c.req.valid('param');
    const result = await useCases.getRelation(requireActor(c), project, relation);
    // For If-Match on decisions.
    c.header('etag', versionEtag(result.version));
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.listFindings), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(await useCases.listFindings(requireActor(c), project), 200);
  });
}
