import { createRoute } from '@hono/zod-openapi';
import { MAX_VALUE_CHAIN_BODY_BYTES, apiRoutes } from '@proa/contracts';
import { bodyLimit } from 'hono/body-limit';

import { DomainError } from '../../domain/errors.ts';
import type { ChainContent, UseCases } from '../../domain/use-cases/index.ts';
import { notJson } from '../../domain/value-chain/document.ts';
import { requireActor, type App } from '../context.ts';
import { contentPrecondition, matchesEtag, revisionEtag } from '../etag.ts';
import { problemResponse } from '../problem.ts';
import { toHonoPath } from './not-implemented.ts';

function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * The content save reads its body itself: the document is validated by
 * schema-model and the ProA rules (422 `value-chain-invalid` with
 * violations), not by the route's JSON schema. The OpenAPI document still
 * comes from the contracts.
 */
const putContentRoute = createRoute({
  ...apiRoutes.putValueChainContent,
  request: {
    params: apiRoutes.putValueChainContent.request.params,
    query: apiRoutes.putValueChainContent.request.query,
    headers: apiRoutes.putValueChainContent.request.headers,
  },
});

/** The canonical bytes of a revision: JSON, revalidated on every use, never cached by proxies. */
function contentResponse(content: ChainContent): Response {
  return new Response(new Uint8Array(content.bytes), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      etag: revisionEtag(content.rev),
      'cache-control': 'private, no-cache',
    },
  });
}

/** The value chain (M4 §3.5): the chain, its content with `If-Match` and `dryRun`, revisions, steps, findings. */
export function registerValueChainRoutes(app: App, useCases: UseCases): void {
  const tooLarge = () =>
    problemResponse(
      'payload-too-large',
      `a value chain document may have at most ${MAX_VALUE_CHAIN_BODY_BYTES} bytes`,
    );
  for (const route of [apiRoutes.createValueChain, apiRoutes.putValueChainContent]) {
    app.use(
      toHonoPath(route.path),
      bodyLimit({ maxSize: MAX_VALUE_CHAIN_BODY_BYTES, onError: tooLarge }),
    );
  }

  app.openapi(createRoute(apiRoutes.listValueChains), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(await useCases.listValueChains(requireActor(c), project), 200);
  });

  app.openapi(createRoute(apiRoutes.createValueChain), async (c) => {
    const { project } = c.req.valid('param');
    const result = await useCases.createValueChain(requireActor(c), project, c.req.valid('json'));
    if (result.valueChain) c.header('etag', revisionEtag(result.valueChain.headRev));
    return c.json(result, 201);
  });

  app.openapi(createRoute(apiRoutes.getValueChain), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(await useCases.getValueChain(requireActor(c), project, key), 200);
  });

  app.openapi(createRoute(apiRoutes.deleteValueChain), async (c) => {
    const { project, key } = c.req.valid('param');
    await useCases.deleteValueChain(requireActor(c), project, key);
    return c.body(null, 204);
  });

  app.openapi(createRoute(apiRoutes.getValueChainContent), async (c) => {
    const { project, key } = c.req.valid('param');
    const content = await useCases.getValueChainContent(requireActor(c), project, key);
    const etag = revisionEtag(content.rev);
    if (matchesEtag(c.req.valid('header')['if-none-match'], etag)) {
      return c.body(null, 304, { etag, 'cache-control': 'private, no-cache' });
    }
    return contentResponse(content);
  });

  app.openapi(putContentRoute, async (c) => {
    const actor = requireActor(c);
    const { project, key } = c.req.valid('param');
    const { dryRun } = c.req.valid('query');
    const headers = c.req.valid('header');
    if (mediaType(c.req.header('content-type')) !== 'application/json') {
      throw new DomainError('unsupported-media-type', 'send the value chain as application/json');
    }
    const text = await c.req.text();
    let input: unknown;
    try {
      input = JSON.parse(text);
    } catch (err) {
      throw notJson(`the body is not JSON (${err instanceof Error ? err.name : 'error'})`);
    }
    const pre = contentPrecondition(headers['if-match'], headers['if-none-match']);
    const result = await useCases.saveValueChainContent(actor, project, key, input, pre, {
      dryRun: dryRun === 'true',
    });
    if (result.valueChain) c.header('etag', revisionEtag(result.valueChain.headRev));
    const created =
      !result.dryRun && (result.outcome === 'created' || result.outcome === 'revived');
    return created ? c.json(result, 201) : c.json(result, 200);
  });

  app.openapi(createRoute(apiRoutes.listValueChainRevisions), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(
      await useCases.listValueChainRevisions(requireActor(c), project, key, c.req.valid('query')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.getValueChainRevisionContent), async (c) => {
    const { project, key, rev } = c.req.valid('param');
    return contentResponse(
      await useCases.getValueChainContent(requireActor(c), project, key, rev),
    ) as never;
  });

  app.openapi(createRoute(apiRoutes.getValueChainStep), async (c) => {
    const { project, key, elementId } = c.req.valid('param');
    return c.json(await useCases.getValueChainStep(requireActor(c), project, key, elementId), 200);
  });

  app.openapi(createRoute(apiRoutes.getValueChainFindings), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(await useCases.getValueChainFindings(requireActor(c), project, key), 200);
  });

  app.openapi(createRoute(apiRoutes.listUnplacedProcesses), async (c) => {
    const { project, key } = c.req.valid('param');
    return c.json(
      await useCases.listUnplacedProcesses(requireActor(c), project, key, c.req.valid('query')),
      200,
    );
  });
}
