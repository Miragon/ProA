import { createRoute } from '@hono/zod-openapi';
import { apiRoutes } from '@proa/contracts';

import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { ifMatchVersion, versionEtag } from '../etag.ts';

/** Review (CONCEPT §3): decisions, bulk decisions, notes, timeline, ad-hoc proposals. */
export function registerReviewRoutes(app: App, useCases: UseCases): void {
  app.openapi(createRoute(apiRoutes.decideRelation), async (c) => {
    const { project, relation } = c.req.valid('param');
    const ifMatch = ifMatchVersion(c.req.valid('header')['if-match']);
    const result = await useCases.decideRelation(
      requireActor(c),
      project,
      relation,
      c.req.valid('json'),
      ifMatch,
    );
    c.header('etag', versionEtag(result.relation.version));
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.decideRelations), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(
      await useCases.decideRelations(requireActor(c), project, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.addRelationNote), async (c) => {
    const { project, relation } = c.req.valid('param');
    return c.json(
      await useCases.addRelationNote(requireActor(c), project, relation, c.req.valid('json')),
      201,
    );
  });

  app.openapi(createRoute(apiRoutes.getRelationAssertions), async (c) => {
    const { project, relation } = c.req.valid('param');
    return c.json(await useCases.getRelationAssertions(requireActor(c), project, relation), 200);
  });

  app.openapi(createRoute(apiRoutes.proposeRelation), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(
      await useCases.proposeRelation(requireActor(c), project, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.withdrawProposal), async (c) => {
    const { project, relation } = c.req.valid('param');
    return c.json(await useCases.withdrawProposal(requireActor(c), project, relation), 200);
  });
}
