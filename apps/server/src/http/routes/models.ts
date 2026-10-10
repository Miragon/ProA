import { createRoute } from '@hono/zod-openapi';
import { MAX_IMPORT_BYTES, MAX_IMPORT_FILES, MAX_MODEL_BYTES, apiRoutes } from '@proa/contracts';
import { bodyLimit } from 'hono/body-limit';

import { DomainError } from '../../domain/errors.ts';
import type { UploadFile, UseCases } from '../../domain/use-cases/index.ts';
import { requireActor, type App } from '../context.ts';
import { problemResponse } from '../problem.ts';
import { toHonoPath } from './not-implemented.ts';

const XML_TYPES = ['application/xml', 'text/xml'];
/** Multipart framing on top of the 25 MB of file content. */
const MULTIPART_OVERHEAD = 1024 * 1024;

/** `finanzen/mahnwesen` + `rev_01…` → `finanzen-mahnwesen.rev_01….bpmn` (model keys are ASCII slugs). */
export function downloadName(modelKey: string, revisionId: string): string {
  return `${modelKey.replaceAll('/', '-')}.${revisionId}.bpmn`;
}

function mediaType(header: string | undefined): string {
  return (header ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * Raw-body and multipart routes are registered without their body schema:
 * `@hono/zod-openapi` would validate multipart parts as strings, and XML is
 * read as bytes here. The OpenAPI document still comes from the contracts.
 */
const putModelRoute = createRoute({
  ...apiRoutes.putModelByKey,
  request: { params: apiRoutes.putModelByKey.request.params },
});
const importModelsRoute = createRoute({
  ...apiRoutes.importModels,
  request: { params: apiRoutes.importModels.request.params },
});

/** Models, revisions, upload and import (CONCEPT §5). */
export function registerModelRoutes(app: App, useCases: UseCases): void {
  app.use(
    toHonoPath(apiRoutes.putModelByKey.path),
    bodyLimit({
      maxSize: MAX_MODEL_BYTES,
      onError: () =>
        problemResponse('payload-too-large', `a model may have at most ${MAX_MODEL_BYTES} bytes`),
    }),
  );
  app.use(
    toHonoPath(apiRoutes.importModels.path),
    bodyLimit({
      maxSize: MAX_IMPORT_BYTES + MULTIPART_OVERHEAD,
      onError: () =>
        problemResponse(
          'payload-too-large',
          `an import may have at most ${MAX_IMPORT_BYTES} bytes`,
        ),
    }),
  );

  app.openapi(createRoute(apiRoutes.listModels), async (c) => {
    const { project } = c.req.valid('param');
    return c.json(await useCases.listModels(requireActor(c), project, c.req.valid('query')), 200);
  });

  app.openapi(createRoute(apiRoutes.getModel), async (c) => {
    const { project, model } = c.req.valid('param');
    return c.json(await useCases.getModel(requireActor(c), project, model), 200);
  });

  app.openapi(createRoute(apiRoutes.deleteModel), async (c) => {
    const { project, model } = c.req.valid('param');
    await useCases.deleteModel(requireActor(c), project, model);
    return c.body(null, 204);
  });

  app.openapi(putModelRoute, async (c) => {
    const actor = requireActor(c);
    const { project, key } = c.req.valid('param');
    if (!XML_TYPES.includes(mediaType(c.req.header('content-type')))) {
      throw new DomainError(
        'unsupported-media-type',
        'send the BPMN as application/xml or text/xml',
      );
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    const result = await useCases.putModel(actor, project, key, bytes);
    return c.json(result, result.outcome === 'created' ? 201 : 200);
  });

  app.openapi(createRoute(apiRoutes.listRevisions), async (c) => {
    const { project, model } = c.req.valid('param');
    return c.json(
      await useCases.listRevisions(requireActor(c), project, model, c.req.valid('query')),
      200,
    );
  });

  app.openapi(createRoute(apiRoutes.getRevisionContent), async (c) => {
    const { project, model, revision } = c.req.valid('param');
    const content = await useCases.getRevisionContent(requireActor(c), project, model, revision);
    // Uploaded bytes, verbatim: never rendered by a browser on the ProA
    // origin (an XHTML <script> in the XML would run as the owner). The
    // download, nosniff and the sandbox CSP (securityHeaders) keep it inert.
    return c.body(new Uint8Array(content.bytes), 200, {
      'content-type': 'application/xml',
      'content-disposition': `attachment; filename="${downloadName(content.modelKey, revision)}"`,
      'cache-control': 'private, no-store',
    });
  });

  app.openapi(createRoute(apiRoutes.getRevisionFacts), async (c) => {
    const { project, model, revision } = c.req.valid('param');
    return c.json(await useCases.getRevisionFacts(requireActor(c), project, model, revision), 200);
  });

  app.openapi(importModelsRoute, async (c) => {
    const actor = requireActor(c);
    const { project } = c.req.valid('param');
    if (mediaType(c.req.header('content-type')) !== 'multipart/form-data') {
      throw new DomainError('unsupported-media-type', 'send the files as multipart/form-data');
    }
    const form = await c.req.parseBody({ all: true });
    const parts = [form['files'], form['files[]']].flat().filter((p) => p !== undefined);
    if (parts.length > MAX_IMPORT_FILES) {
      throw new DomainError('validation-failed', `at most ${MAX_IMPORT_FILES} files per import`);
    }
    const files: UploadFile[] = [];
    for (const part of parts) {
      if (typeof part === 'string') {
        throw new DomainError('validation-failed', 'every `files` part must be a file');
      }
      files.push({ path: part.name, bytes: new Uint8Array(await part.arrayBuffer()) });
    }
    return c.json(await useCases.importFiles(actor, project, files), 200);
  });
}
