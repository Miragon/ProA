import { createRoute } from '@hono/zod-openapi';
import { apiRoutes } from '@proa/contracts';

import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';

/** `GET/POST /api/v1/projects`, `GET /api/v1/projects/{project}`. */
export function registerProjectRoutes(app: App, useCases: UseCases): void {
  app.openapi(createRoute(apiRoutes.listProjects), async (c) =>
    c.json(await useCases.listProjects(requireActor(c), c.req.valid('query')), 200),
  );

  app.openapi(createRoute(apiRoutes.createProject), async (c) => {
    const project = await useCases.createProject(requireActor(c), c.req.valid('json'));
    c.header('location', `/api/v1/projects/${project.id}`);
    return c.json(project, 201);
  });

  app.openapi(createRoute(apiRoutes.getProject), async (c) =>
    c.json(await useCases.getProject(requireActor(c), c.req.valid('param').project), 200),
  );
}
