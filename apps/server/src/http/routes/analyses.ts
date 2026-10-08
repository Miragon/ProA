import { createRoute } from '@hono/zod-openapi';
import { MAX_SUBMISSION_BYTES, apiRoutes } from '@proa/contracts';
import { bodyLimit } from 'hono/body-limit';

import type { UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { problemResponse } from '../problem.ts';
import { toHonoPath } from './not-implemented.ts';

/** The analysis pipeline (CONCEPT §3, §5): claim, submit, release, pending, tasks, requeue. */
export function registerAnalysisRoutes(app: App, useCases: UseCases): void {
  app.use(
    toHonoPath(apiRoutes.submitAnalysis.path),
    bodyLimit({
      maxSize: MAX_SUBMISSION_BYTES,
      onError: () =>
        problemResponse(
          'payload-too-large',
          `a submission may have at most ${MAX_SUBMISSION_BYTES} bytes`,
        ),
    }),
  );

  app.openapi(createRoute(apiRoutes.claimAnalyses), async (c) => {
    const result = await useCases.claimAnalyses(requireActor(c), c.req.valid('json'));
    // Lease tokens are in this response only.
    c.header('cache-control', 'no-store');
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.getPendingAnalyses), async (c) => {
    const result = await useCases.pendingAnalyses(
      requireActor(c),
      c.req.valid('query'),
      c.req.raw.signal,
    );
    c.header('cache-control', 'no-store');
    return c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.submitAnalysis), async (c) => {
    const { analysis } = c.req.valid('param');
    const body = c.req.valid('json');
    // Stored verbatim (minus the lease token): the body as sent, before defaults.
    const raw: unknown = await c.req.json();
    return c.json(await useCases.submitAnalysis(requireActor(c), analysis, body, raw), 200);
  });

  app.openapi(createRoute(apiRoutes.releaseAnalysis), async (c) => {
    const { analysis } = c.req.valid('param');
    return c.json(
      await useCases.releaseAnalysis(requireActor(c), analysis, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.listAnalyses), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(await useCases.listAnalyses(requireActor(c), project, c.req.valid('query')), 200);
  });

  app.openapi(createRoute(apiRoutes.requeueAnalyses), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(
      await useCases.requeueAnalyses(requireActor(c), project, c.req.valid('json')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.getAnalysisSubmission), async (c) => {
    const { project, analysis } = c.req.valid('param');
    return c.json(await useCases.getAnalysisSubmission(requireActor(c), project, analysis), 200);
  });
}
