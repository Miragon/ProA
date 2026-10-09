import { createRoute } from '@hono/zod-openapi';
import { apiRoutes } from '@proa/contracts';

import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { ifMatchVersion, versionEtag } from '../etag.ts';

/**
 * Placements (M4 §3.5): list, propose or add manually, decide (also in
 * bulk), notes, timeline, withdraw one's own proposal. The bulk route is
 * registered before the `{placement}` routes.
 */
export function registerPlacementRoutes(app: App, useCases: UseCases): void {
  app.openapi(createRoute(apiRoutes.decidePlacements), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(
      await useCases.decidePlacements(requireActor(c), project, key, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.listPlacements), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(
      await useCases.listPlacements(requireActor(c), project, key, c.req.valid('query')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.postPlacements), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(
      await useCases.postPlacements(requireActor(c), project, key, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.getPlacement), async (c) => {
    const { project, key, placement } = c.req.valid('param');
    const result = await useCases.getPlacement(requireActor(c), project, key, placement);
    c.header('etag', versionEtag(result.version));
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.withdrawPlacementProposal), async (c) => {
    const { project, key, placement } = c.req.valid('param');
    return c.json(
      await useCases.withdrawPlacementProposal(requireActor(c), project, key, placement),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.decidePlacement), async (c) => {
    const { project, key, placement } = c.req.valid('param');
    const ifMatch = ifMatchVersion(c.req.valid('header')['if-match']);
    const result = await useCases.decidePlacement(
      requireActor(c),
      project,
      key,
      placement,
      c.req.valid('json'),
      ifMatch,
    );
    c.header('etag', versionEtag(result.placement.version));
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.addPlacementNote), async (c) => {
    const { project, key, placement } = c.req.valid('param');
    return c.json(
      await useCases.addPlacementNote(
        requireActor(c),
        project,
        key,
        placement,
        c.req.valid('json'),
      ),
      201,
    );
  });

  app.openapi(createRoute(apiRoutes.getPlacementAssertions), async (c) => {
    const { project, key, placement } = c.req.valid('param');
    return c.json(
      await useCases.getPlacementAssertions(requireActor(c), project, key, placement),
      200,
    );
  });
}
