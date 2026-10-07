import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import { AgentTokenId, ModelId, RelationId, RevisionId } from '../ids.ts';
import { ApiProblem, PROBLEMS, PROBLEM_CONTENT_TYPE, type ProblemCode } from '../problem.ts';
import { ModelKey } from '../refs.ts';
import { AgentTokenList, CreateAgentTokenBody, CreatedAgentToken } from './agent-tokens.ts';
import { Me } from './auth.ts';
import { CreateSessionBody, SESSION_COOKIE } from './session.ts';
import { API_PREFIX, PageQuery, ProjectParam } from './common.ts';
import { Health } from './health.ts';
import { Landscape } from './landscape.ts';
import {
  ImportResult,
  Model,
  ModelPage,
  ModelStage,
  PutModelResult,
  RevisionFacts,
  RevisionPage,
} from './models.ts';
import { CreateProjectBody, Project, ProjectPage } from './projects.ts';
import { FindingList, Relation, RelationPage, RelationQuery } from './relations.ts';

const JSON_TYPE = 'application/json';

function json<T extends z.ZodType>(schema: T, description: string) {
  return { description, content: { [JSON_TYPE]: { schema } } };
}

/** Problem responses for the given codes (duplicates ignored), grouped by HTTP status. */
function problems(...codes: ProblemCode[]) {
  const out: Record<
    number,
    { description: string; content: Record<string, { schema: typeof ApiProblem }> }
  > = {};
  for (const code of new Set(codes)) {
    const { status } = PROBLEMS[code];
    const prev = out[status];
    out[status] = {
      description: prev ? `${prev.description}, \`${code}\`` : `Problem: \`${code}\``,
      content: { [PROBLEM_CONTENT_TYPE]: { schema: ApiProblem } },
    };
  }
  return out;
}

const projectParams = ProjectParam;
const modelParams = ProjectParam.extend({ model: ModelId });
const revisionParams = modelParams.extend({ revision: RevisionId });
const BpmnXml = z.string().meta({ id: 'BpmnXml', description: 'BPMN 2.0 XML document (UTF-8).' });

/**
 * Problems of every route below `/projects/{project}`: no or a rejected
 * credential, a token without the scope, an unknown or foreign project or
 * resource, and malformed params or query (422 from the server's validation
 * hook).
 */
const READ_PROBLEMS = [
  'unauthorized',
  'insufficient-scope',
  'not-found',
  'validation-failed',
] as const;

/**
 * Every REST route of the ProA API (CONCEPT §5), as zod-to-openapi route
 * configs. The server mounts them with `@hono/zod-openapi`'s `createRoute`;
 * `buildOpenApiDocument()` turns them into the OpenAPI 3.1 document the client
 * is generated from. Paths are absolute (`/health`, `/api/v1/...`).
 *
 * `{project}` takes a project id or key. `{key}` in `models/by-key/{key}` is a
 * model key with `/` percent-encoded as `%2F`.
 */
export const apiRoutes = {
  getHealth: {
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    tags: ['system'],
    summary: 'Liveness and database ping',
    security: [],
    responses: { 200: json(Health, 'Server health'), 503: json(Health, 'Database unreachable') },
  },
  createSession: {
    method: 'post',
    path: `${API_PREFIX}/session`,
    operationId: 'createSession',
    tags: ['system'],
    summary: 'Local mode: open an owner session (HttpOnly cookie) for the web UI or the CLI',
    description:
      `Local mode only (\`PROA_AUTH=local\`). Sets the \`${SESSION_COOKIE}\` cookie (HttpOnly, ` +
      'SameSite=Strict); requests carrying it act as the single owner on an interactive client. ' +
      'The server accepts it only from localhost (Host and Origin checks).',
    security: [],
    request: {
      body: { required: false, content: { [JSON_TYPE]: { schema: CreateSessionBody } } },
    },
    responses: {
      200: {
        ...json(Me, 'The owner'),
        headers: z.object({
          'Set-Cookie': z.string().meta({ description: `\`${SESSION_COOKIE}=…\`` }),
        }),
      },
      ...problems('forbidden', 'unsupported-media-type', 'validation-failed'),
    },
  },
  deleteSession: {
    method: 'delete',
    path: `${API_PREFIX}/session`,
    operationId: 'deleteSession',
    tags: ['system'],
    summary: 'Local mode: end the owner session (clears the cookie)',
    security: [],
    responses: { 204: { description: 'Session cookie cleared' } },
  },
  getMe: {
    method: 'get',
    path: `${API_PREFIX}/me`,
    operationId: 'getMe',
    tags: ['system'],
    summary: 'The authenticated caller',
    responses: { 200: json(Me, 'The caller'), ...problems('unauthorized') },
  },

  listProjects: {
    method: 'get',
    path: `${API_PREFIX}/projects`,
    operationId: 'listProjects',
    tags: ['projects'],
    summary: 'Projects the caller is a member of',
    request: { query: PageQuery },
    responses: {
      200: json(ProjectPage, 'A page of projects'),
      ...problems('unauthorized', 'insufficient-scope', 'validation-failed'),
    },
  },
  createProject: {
    method: 'post',
    path: `${API_PREFIX}/projects`,
    operationId: 'createProject',
    tags: ['projects'],
    summary: 'Create a project; the caller becomes its owner',
    request: { body: { required: true, content: { [JSON_TYPE]: { schema: CreateProjectBody } } } },
    responses: {
      201: json(Project, 'The new project'),
      ...problems('unauthorized', 'forbidden', 'conflict', 'validation-failed'),
    },
  },
  getProject: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}`,
    operationId: 'getProject',
    tags: ['projects'],
    summary: 'One project',
    request: { params: projectParams },
    responses: { 200: json(Project, 'The project'), ...problems(...READ_PROBLEMS) },
  },

  listModels: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/models`,
    operationId: 'listModels',
    tags: ['models'],
    summary: 'Models of a project, optionally filtered by pipeline stage',
    request: { params: projectParams, query: PageQuery.extend({ stage: ModelStage.optional() }) },
    responses: { 200: json(ModelPage, 'A page of models'), ...problems(...READ_PROBLEMS) },
  },
  getModel: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/models/{model}`,
    operationId: 'getModel',
    tags: ['models'],
    summary: 'One model',
    request: { params: modelParams },
    responses: { 200: json(Model, 'The model'), ...problems(...READ_PROBLEMS) },
  },
  deleteModel: {
    method: 'delete',
    path: `${API_PREFIX}/projects/{project}/models/{model}`,
    operationId: 'deleteModel',
    tags: ['models'],
    summary: 'Delete a model; partner relations become `missing`',
    request: { params: modelParams },
    responses: { 204: { description: 'Deleted' }, ...problems(...READ_PROBLEMS, 'forbidden') },
  },
  putModelByKey: {
    method: 'put',
    path: `${API_PREFIX}/projects/{project}/models/by-key/{key}`,
    operationId: 'putModelByKey',
    tags: ['models'],
    summary: 'Upload raw BPMN: 201 new model, 200 new revision or unchanged',
    request: {
      params: projectParams.extend({ key: ModelKey }),
      body: {
        required: true,
        content: { 'application/xml': { schema: BpmnXml }, 'text/xml': { schema: BpmnXml } },
      },
    },
    responses: {
      200: json(PutModelResult, 'New revision, or `unchanged` for identical content'),
      201: json(PutModelResult, 'New model'),
      ...problems(
        ...READ_PROBLEMS,
        'forbidden',
        'payload-too-large',
        'unsupported-media-type',
        'bpmn-invalid',
        'validation-failed',
      ),
    },
  },
  listRevisions: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/models/{model}/revisions`,
    operationId: 'listRevisions',
    tags: ['models'],
    summary: 'Revisions of a model, newest first',
    request: { params: modelParams, query: PageQuery },
    responses: { 200: json(RevisionPage, 'A page of revisions'), ...problems(...READ_PROBLEMS) },
  },
  getRevisionContent: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/models/{model}/revisions/{revision}/content`,
    operationId: 'getRevisionContent',
    tags: ['models'],
    summary: 'The verbatim BPMN bytes of a revision',
    request: { params: revisionParams },
    responses: {
      200: { description: 'BPMN XML', content: { 'application/xml': { schema: BpmnXml } } },
      ...problems(...READ_PROBLEMS),
    },
  },
  getRevisionFacts: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/models/{model}/revisions/{revision}/facts`,
    operationId: 'getRevisionFacts',
    tags: ['models'],
    summary: 'Facts extracted from a revision',
    request: { params: revisionParams },
    responses: { 200: json(RevisionFacts, 'Facts'), ...problems(...READ_PROBLEMS) },
  },
  importModels: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/imports`,
    operationId: 'importModels',
    tags: ['models'],
    summary: 'Import up to 50 BPMN files; the model key is the slugified path',
    request: {
      params: projectParams,
      body: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: z
              .object({
                files: z
                  .array(z.string().meta({ format: 'binary' }))
                  .min(1)
                  .meta({
                    description:
                      'BPMN files; each part’s filename is its path below the import root.',
                  }),
              })
              .meta({ id: 'ImportModelsBody' }),
          },
        },
      },
    },
    responses: {
      200: json(ImportResult, 'Outcome per file'),
      ...problems(
        ...READ_PROBLEMS,
        'forbidden',
        'payload-too-large',
        'unsupported-media-type',
        'validation-failed',
      ),
    },
  },

  getLandscape: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/landscape`,
    operationId: 'getLandscape',
    tags: ['relations'],
    summary: 'The project head: models, processes, relations, findings (ETag `"s<seq>"`)',
    request: { params: projectParams },
    responses: {
      200: {
        ...json(Landscape, 'The landscape'),
        headers: z.object({ ETag: z.string().meta({ description: '`"s<seq>"`' }) }),
      },
      304: { description: 'Not modified (`If-None-Match` matched)' },
      ...problems(...READ_PROBLEMS),
    },
  },
  listRelations: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/relations`,
    operationId: 'listRelations',
    tags: ['relations'],
    summary: 'Relations, filtered by type, status, tier or model',
    request: { params: projectParams, query: RelationQuery },
    responses: { 200: json(RelationPage, 'A page of relations'), ...problems(...READ_PROBLEMS) },
  },
  getRelation: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/relations/{relation}`,
    operationId: 'getRelation',
    tags: ['relations'],
    summary: 'One relation',
    request: { params: projectParams.extend({ relation: RelationId }) },
    responses: { 200: json(Relation, 'The relation'), ...problems(...READ_PROBLEMS) },
  },
  listFindings: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/findings`,
    operationId: 'listFindings',
    tags: ['relations'],
    summary: 'Deterministic findings of the project head',
    request: { params: projectParams },
    responses: { 200: json(FindingList, 'Findings'), ...problems(...READ_PROBLEMS) },
  },

  listAgentTokens: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/agent-tokens`,
    operationId: 'listAgentTokens',
    tags: ['agent-tokens'],
    summary: "A project's agent tokens (owner only)",
    request: { params: projectParams },
    responses: {
      200: json(AgentTokenList, 'Agent tokens'),
      ...problems(...READ_PROBLEMS, 'forbidden'),
    },
  },
  createAgentToken: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/agent-tokens`,
    operationId: 'createAgentToken',
    tags: ['agent-tokens'],
    summary: 'Create an agent token; the secret is shown once (owner, interactive client)',
    request: {
      params: projectParams,
      body: { required: true, content: { [JSON_TYPE]: { schema: CreateAgentTokenBody } } },
    },
    responses: {
      201: json(CreatedAgentToken, 'The new token with its secret'),
      ...problems(...READ_PROBLEMS, 'forbidden', 'validation-failed'),
    },
  },
  revokeAgentToken: {
    method: 'delete',
    path: `${API_PREFIX}/projects/{project}/agent-tokens/{token}`,
    operationId: 'revokeAgentToken',
    tags: ['agent-tokens'],
    summary: 'Revoke an agent token (owner, interactive client)',
    request: { params: projectParams.extend({ token: AgentTokenId }) },
    responses: { 204: { description: 'Revoked' }, ...problems(...READ_PROBLEMS, 'forbidden') },
  },
} as const satisfies Record<string, RouteConfig>;

export type ApiRouteName = keyof typeof apiRoutes;
