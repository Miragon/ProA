import { apiRoutes } from '@proa/contracts';

import type { App } from '../context.ts';
import { problemResponse } from '../problem.ts';

/** `/api/v1/projects/{project}` → `/api/v1/projects/:project` */
export function toHonoPath(openApiPath: string): string {
  return openApiPath.replace(/\{(\w+)\}/g, ':$1');
}

/**
 * Answers every contract route that has no handler yet with 501
 * `not-implemented`, so the served OpenAPI document never points into a 404.
 * Must be called after all real routes are registered.
 *
 * @returns operation ids of the routes that got the 501 placeholder
 */
export function mountNotImplementedRoutes(app: App): string[] {
  const placeholders: string[] = [];
  for (const [name, route] of Object.entries(apiRoutes)) {
    const method = route.method.toUpperCase();
    const path = toHonoPath(route.path);
    const implemented = app.routes.some((r) => r.method === method && r.path === path);
    if (implemented) continue;
    placeholders.push(name);
    app.on(method, path, () =>
      problemResponse('not-implemented', `${route.operationId} is not implemented yet`),
    );
  }
  return placeholders;
}
