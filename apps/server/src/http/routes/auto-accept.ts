import { createRoute } from '@hono/zod-openapi';
import { apiRoutes } from '@proa/contracts';

import type { RulePrecondition, UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { ifMatchRevision, revisionEtag } from '../etag.ts';

/**
 * The precondition of a rule edit: `If-Match: "r<revision>"` (one tag). A
 * missing header, `*` or a tag naming no revision is `none` (428 once the
 * caller is authorized).
 */
function rulePrecondition(ifMatch: string | undefined): RulePrecondition {
  const rev = ifMatchRevision(ifMatch);
  return rev === undefined ? { kind: 'none' } : { kind: 'if-match', rev };
}

/**
 * Auto-accept rules (owner decision 19): owners on an interactive client
 * only; no MCP counterpart. Rules carry `ETag: "r<revision>"`; edits need
 * `If-Match`. Apply and revocation take `?dryRun=true`.
 */
export function registerAutoAcceptRoutes(app: App, useCases: UseCases): void {
  app.openapi(createRoute(apiRoutes.listAutoAcceptRules), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(await useCases.listAutoAcceptRules(requireActor(c), project), 200);
  });

  app.openapi(createRoute(apiRoutes.createAutoAcceptRule), async (c) => {
    const { project } = c.req.valid('param');
    const result = await useCases.createAutoAcceptRule(
      requireActor(c),
      project,
      c.req.valid('json'),
    );
    c.header('etag', revisionEtag(result.rule.revision));
    return c.json(result, 201);
  });

  app.openapi(createRoute(apiRoutes.previewAutoAcceptRule), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(
      await useCases.previewAutoAcceptRule(requireActor(c), project, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.getAutoAcceptRule), async (c) => {
    const { project, rule } = c.req.valid('param');
    const detail = await useCases.getAutoAcceptRule(requireActor(c), project, rule);
    c.header('etag', revisionEtag(detail.revision));
    return c.json(detail, 200);
  });

  app.openapi(createRoute(apiRoutes.reviseAutoAcceptRule), async (c) => {
    const { project, rule } = c.req.valid('param');
    const result = await useCases.reviseAutoAcceptRule(
      requireActor(c),
      project,
      rule,
      c.req.valid('json'),
      rulePrecondition(c.req.valid('header')['if-match']),
    );
    c.header('etag', revisionEtag(result.rule.revision));
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.applyAutoAcceptRule), async (c) => {
    const { project, rule } = c.req.valid('param');
    const { dryRun } = c.req.valid('query');
    return c.json(
      await useCases.applyAutoAcceptRule(requireActor(c), project, rule, c.req.valid('json'), {
        dryRun: dryRun === 'true',
      }),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.revokeAutoAccepted), async (c) => {
    const { project } = c.req.valid('param');
    const { dryRun } = c.req.valid('query');
    return c.json(
      await useCases.revokeAutoAccepted(requireActor(c), project, c.req.valid('json'), {
        dryRun: dryRun === 'true',
      }),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.listAutoAccepted), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(
      await useCases.listAutoAccepted(requireActor(c), project, c.req.valid('query')),
      200,
    );
  });
}
