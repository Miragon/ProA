import { createRoute } from '@hono/zod-openapi';
import { apiRoutes } from '@proa/contracts';

import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';

/** Agent tokens of a project (CONCEPT §6): owner on an interactive client only. */
export function registerAgentTokenRoutes(app: App, useCases: UseCases): void {
  app.openapi(createRoute(apiRoutes.listAgentTokens), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(await useCases.listAgentTokens(requireActor(c), project), 200);
  });

  app.openapi(createRoute(apiRoutes.createAgentToken), async (c) => {
    const { project } = c.req.valid('param');
    const token = await useCases.createAgentToken(requireActor(c), project, c.req.valid('json'));
    // The secret is in this response only.
    c.header('cache-control', 'no-store');
    return c.json(token, 201);
  });

  app.openapi(createRoute(apiRoutes.revokeAgentToken), async (c) => {
    const { project, token } = c.req.valid('param');
    await useCases.revokeAgentToken(requireActor(c), project, token);
    return c.body(null, 204);
  });
}
