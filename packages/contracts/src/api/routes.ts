import type { RouteConfig } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';

import {
  AgentTokenId,
  AnalysisTaskId,
  ModelId,
  PlacementId,
  RelationId,
  RevisionId,
} from '../ids.ts';
import { ApiProblem, PROBLEMS, PROBLEM_CONTENT_TYPE, type ProblemCode } from '../problem.ts';
import { ModelKey } from '../refs.ts';
import { AgentTokenList, CreateAgentTokenBody, CreatedAgentToken } from './agent-tokens.ts';
import {
  AnalysisQuery,
  AnalysisSubmission,
  AnalysisSubmissionResult,
  AnalysisTaskPage,
  ClaimAnalysisBody,
  ClaimResult,
  PendingAnalyses,
  PendingQuery,
  ReleaseAnalysisBody,
  ReleaseResult,
  RequeueBody,
  RequeueResult,
  SubmitAnalysisBody,
} from './analyses.ts';
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
import {
  BulkPlacementDecisionBody,
  BulkPlacementDecisionResult,
  Placement,
  PlacementAssertion,
  PlacementAssertionList,
  PlacementDecisionBody,
  PlacementDecisionResult,
  PlacementPage,
  PlacementQuery,
  PostPlacementsBody,
  PostPlacementsResult,
  UnplacedProcessPage,
  ValueChainDetail,
  ValueChainFindingList,
  ValueChainStepDetail,
} from './placements.ts';
import { CreateProjectBody, Project, ProjectPage } from './projects.ts';
import {
  FindingList,
  Relation,
  RelationAssertion,
  RelationAssertionList,
  RelationPage,
  RelationQuery,
} from './relations.ts';
import {
  BulkDecisionBody,
  BulkDecisionResult,
  DecisionBody,
  DecisionResult,
  NoteBody,
  ProposeRelationBody,
  ProposeRelationResult,
} from './review.ts';
import {
  CreateValueChainBody,
  MAX_VALUE_CHAIN_DEPTH,
  MAX_VALUE_CHAIN_REV,
  SaveValueChainQuery,
  SaveValueChainResult,
  ValueChainDocument,
  ValueChainKey,
  ValueChainList,
  ValueChainRevisionPage,
} from './value-chains.ts';

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
const relationParams = ProjectParam.extend({ relation: RelationId });
const analysisParams = z.object({ analysis: AnalysisTaskId });
const chainParams = ProjectParam.extend({ key: ValueChainKey });
const chainRevisionParams = chainParams.extend({
  rev: z.coerce.number().int().min(1).max(MAX_VALUE_CHAIN_REV),
});
const stepParams = chainParams.extend({ elementId: z.string().min(1).max(128) });
const placementParams = chainParams.extend({ placement: PlacementId });
const projectAnalysisParams = ProjectParam.extend({ analysis: AnalysisTaskId });

function jsonBody<T extends z.ZodType>(schema: T) {
  return { required: true, content: { [JSON_TYPE]: { schema } } };
}

/**
 * Problems of the pipeline routes (`/analyses/…`): the lease rules of
 * CONCEPT §3 (`lease-lost`, `task-cancelled`, `already-submitted`) on top of
 * the read problems.
 */
const LEASE_PROBLEMS = ['lease-lost', 'task-cancelled', 'already-submitted'] as const;

/**
 * Problems of the review routes: agents get `human-decision-required`
 * (with `reviewUrl`), a stale `version` or count gets `conflict`, a stale
 * `If-Match` `precondition-failed`.
 */
const REVIEW_PROBLEMS = [
  'human-decision-required',
  'forbidden',
  'conflict',
  'validation-failed',
] as const;
const BpmnXml = z.string().meta({ id: 'BpmnXml', description: 'BPMN 2.0 XML document (UTF-8).' });

/**
 * Problems of value chain writes (M4): agents get `human-decision-required`
 * with the value chain `reviewUrl`, a document that fails schema-model or the
 * ProA rules `value-chain-invalid` (with `violations`), a newer schema
 * version `value-chain-unsupported-version`.
 */
const CHAIN_WRITE_PROBLEMS = [
  'human-decision-required',
  'forbidden',
  'value-chain-invalid',
  'value-chain-unsupported-version',
  'payload-too-large',
] as const;

/** ETag of a value chain revision: `"r<rev>"`. */
const REVISION_ETAG = z.object({ ETag: z.string().meta({ description: '`"r<rev>"`' }) });
/** ETag of a placement version: `"<version>"`, for `If-Match` on decisions. */
const VERSION_ETAG = z.object({ ETag: z.string().meta({ description: '`"<version>"`' }) });

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
    request: { params: relationParams },
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

  getRelationAssertions: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/relations/{relation}/assertions`,
    operationId: 'getRelationAssertions',
    tags: ['relations'],
    summary: 'The history (timeline) of a relation: every assertion, oldest first',
    request: { params: relationParams },
    responses: {
      200: json(RelationAssertionList, 'The assertions'),
      ...problems(...READ_PROBLEMS),
    },
  },
  proposeRelation: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/relations`,
    operationId: 'proposeRelation',
    tags: ['review'],
    summary:
      'Propose a relation ad hoc (proa:propose), or add an accepted manual relation (humans)',
    description:
      'Agents and humans propose `call`, `message`, `signal` and `trigger` relations; the server ' +
      'computes the tier. An invalid proposal (unknown ref, wrong endpoint kinds, same process) is ' +
      '422 with `reason`. `manual` relations are for humans only and are accepted at once.',
    request: { params: projectParams, body: jsonBody(ProposeRelationBody) },
    responses: {
      200: json(ProposeRelationResult, 'The outcome and the relation'),
      ...problems(...READ_PROBLEMS, 'human-decision-required', 'forbidden'),
    },
  },
  withdrawProposal: {
    method: 'delete',
    path: `${API_PREFIX}/projects/{project}/relations/{relation}/proposal`,
    operationId: 'withdrawProposal',
    tags: ['review'],
    summary: "Withdraw the caller's own live proposal of a relation",
    request: { params: relationParams },
    responses: {
      200: json(Relation, 'The relation after the withdrawal'),
      ...problems(...READ_PROBLEMS, 'forbidden', 'conflict'),
    },
  },
  decideRelation: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/relations/{relation}/decision`,
    operationId: 'decideRelation',
    tags: ['review'],
    summary: 'Decide a relation: accept, reject, hold or correct (humans only)',
    description:
      'Owner on an interactive client (local mode: the web UI or the CLI). Agent tokens get 403 ' +
      '`human-decision-required` with `reviewUrl`. `If-Match: "<version>"` (or `version` in the ' +
      'body) makes the decision conditional: 412 `precondition-failed` (409 `conflict` for the ' +
      'body field) if the relation changed.',
    request: {
      params: relationParams,
      headers: z.object({ 'if-match': z.string().max(100).optional() }),
      body: jsonBody(DecisionBody),
    },
    responses: {
      200: json(DecisionResult, 'The decided relation'),
      ...problems(...READ_PROBLEMS, ...REVIEW_PROBLEMS, 'precondition-failed'),
    },
  },
  decideRelations: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/decisions`,
    operationId: 'decideRelations',
    tags: ['review'],
    summary: 'Bulk decision with ids, versions and expectedCount (all or nothing)',
    request: { params: projectParams, body: jsonBody(BulkDecisionBody) },
    responses: {
      200: json(BulkDecisionResult, 'The decided relations'),
      ...problems(...READ_PROBLEMS, ...REVIEW_PROBLEMS),
    },
  },
  addRelationNote: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/relations/{relation}/notes`,
    operationId: 'addRelationNote',
    tags: ['review'],
    summary: 'Add a note to a relation, e.g. the answer to a held question (humans only)',
    request: { params: relationParams, body: jsonBody(NoteBody) },
    responses: {
      201: json(RelationAssertion, 'The note'),
      ...problems(...READ_PROBLEMS, ...REVIEW_PROBLEMS),
    },
  },

  listValueChains: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains`,
    operationId: 'listValueChains',
    tags: ['value-chains'],
    summary: 'The value chains of a project (M4: at most one, key `main`)',
    request: { params: projectParams },
    responses: { 200: json(ValueChainList, 'Value chains'), ...problems(...READ_PROBLEMS) },
  },
  createValueChain: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/value-chains`,
    operationId: 'createValueChain',
    tags: ['value-chains'],
    summary: 'Create the value chain from a name or a document (humans only)',
    description:
      'Creates the chain `main` (the only key in M4) with its first revision: an empty document ' +
      'named `name`, or `content`, validated with schema-model and the ProA rules. A deleted ' +
      'chain is revived (same id, `rev` continues, outcome `revived`). 409 `conflict` if a live ' +
      'chain has the key.',
    request: { params: projectParams, body: jsonBody(CreateValueChainBody) },
    responses: {
      201: { ...json(SaveValueChainResult, 'The new chain'), headers: REVISION_ETAG },
      ...problems(...READ_PROBLEMS, ...CHAIN_WRITE_PROBLEMS, 'conflict'),
    },
  },
  getValueChain: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}`,
    operationId: 'getValueChain',
    tags: ['value-chains'],
    summary: 'The value chain: head structure (steps with kinds, ranks, owners), placements',
    request: { params: chainParams },
    responses: {
      200: json(ValueChainDetail, 'The chain with steps and placements'),
      ...problems(...READ_PROBLEMS),
    },
  },
  deleteValueChain: {
    method: 'delete',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}`,
    operationId: 'deleteValueChain',
    tags: ['value-chains'],
    summary: 'Delete the value chain; its placements turn `missing` (humans only)',
    request: { params: chainParams },
    responses: {
      204: { description: 'Deleted' },
      ...problems(...READ_PROBLEMS, 'human-decision-required', 'forbidden'),
    },
  },
  getValueChainContent: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/content`,
    operationId: 'getValueChainContent',
    tags: ['value-chains'],
    summary: 'The head document: canonical `.vc.json` bytes (ETag `"r<rev>"`)',
    request: {
      params: chainParams,
      headers: z.object({ 'if-none-match': z.string().max(200).optional() }),
    },
    responses: {
      200: { ...json(ValueChainDocument, 'The canonical document'), headers: REVISION_ETAG },
      304: { description: 'Not modified (`If-None-Match` names the head revision)' },
      ...problems(...READ_PROBLEMS),
    },
  },
  putValueChainContent: {
    method: 'put',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/content`,
    operationId: 'putValueChainContent',
    tags: ['value-chains'],
    summary:
      'Save a revision: `If-Match: "r<rev>"` required; `?dryRun=true` returns the impact only',
    description:
      'Saves the document as the next revision (humans only). `If-Match: "r<rev>"` must name the ' +
      'head revision: without it 428 `precondition-required`, a stale one 412 ' +
      '`revision-conflict` with `headRev`; content equal to the head answers 200 `unchanged` ' +
      'whatever the `If-Match`. `If-None-Match: *` creates (or revives) the chain instead: 201, ' +
      'or 412 `revision-conflict` if it exists. `dryRun=true` checks the same and returns the ' +
      'impact (removed and changed steps with their placements) without writing anything. The ' +
      'body is the `.vc.json` document as `application/json`, at most 2 MiB; its canonical ' +
      'form may have at most 1 MiB (`document-too-large`).',
    request: {
      params: chainParams,
      query: SaveValueChainQuery,
      headers: z.object({
        'if-match': z.string().max(200).optional(),
        'if-none-match': z.string().max(200).optional(),
      }),
      body: jsonBody(ValueChainDocument),
    },
    responses: {
      200: {
        ...json(SaveValueChainResult, '`revised`, `unchanged`, or a dry run'),
        headers: REVISION_ETAG,
      },
      201: {
        ...json(SaveValueChainResult, '`created` or `revived` (`If-None-Match: *`)'),
        headers: REVISION_ETAG,
      },
      ...problems(
        ...READ_PROBLEMS,
        ...CHAIN_WRITE_PROBLEMS,
        'revision-conflict',
        'precondition-required',
        'unsupported-media-type',
      ),
    },
  },
  listValueChainRevisions: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/revisions`,
    operationId: 'listValueChainRevisions',
    tags: ['value-chains'],
    summary: 'Revisions of the value chain, newest first',
    request: { params: chainParams, query: PageQuery },
    responses: {
      200: json(ValueChainRevisionPage, 'A page of revisions'),
      ...problems(...READ_PROBLEMS),
    },
  },
  getValueChainRevisionContent: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/revisions/{rev}/content`,
    operationId: 'getValueChainRevisionContent',
    tags: ['value-chains'],
    summary: 'The canonical document of one revision (ETag `"r<rev>"`)',
    request: { params: chainRevisionParams },
    responses: {
      200: { ...json(ValueChainDocument, 'The canonical document'), headers: REVISION_ETAG },
      ...problems(...READ_PROBLEMS),
    },
  },
  getValueChainStep: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/steps/{elementId}`,
    operationId: 'getValueChainStep',
    tags: ['value-chains'],
    summary: `The drill-down of a step: breadcrumb, sub-steps (up to level ${MAX_VALUE_CHAIN_DEPTH}), processes`,
    request: { params: stepParams },
    responses: {
      200: json(ValueChainStepDetail, 'The step'),
      ...problems(...READ_PROBLEMS),
    },
  },
  getValueChainFindings: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/findings`,
    operationId: 'getValueChainFindings',
    tags: ['value-chains'],
    summary:
      'Findings of the value chain: processes without a step, steps without a process, unresolved links',
    description:
      'Deterministic, recomputed on read, never blocking (M4 §3.4): `process-without-step` for a ' +
      'head process without an accepted placement on a live step (`@outside` counts), with ' +
      '`state` (pending or held) and the steps of accepted callers; `step-without-process` at ' +
      'the topmost step without an accepted placement on it or below it; `unresolved-link` for ' +
      'a link that is neither `proa:process/<ref>` of a head process nor an http(s) URL.',
    request: { params: chainParams },
    responses: {
      200: json(ValueChainFindingList, 'The findings'),
      ...problems(...READ_PROBLEMS),
    },
  },
  listUnplacedProcesses: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/unplaced-processes`,
    operationId: 'listUnplacedProcesses',
    tags: ['value-chains'],
    summary: 'Processes without a home step and without a placement waiting for review, with hints',
    request: { params: chainParams, query: PageQuery },
    responses: {
      200: json(UnplacedProcessPage, 'A page of unplaced processes'),
      ...problems(...READ_PROBLEMS),
    },
  },
  listPlacements: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements`,
    operationId: 'listPlacements',
    tags: ['value-chains'],
    summary: 'Placements, filtered by step, process, model, status, tier or endpoint state',
    request: { params: chainParams, query: PlacementQuery },
    responses: { 200: json(PlacementPage, 'A page of placements'), ...problems(...READ_PROBLEMS) },
  },
  postPlacements: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements`,
    operationId: 'postPlacements',
    tags: ['value-chains'],
    summary: 'Propose placements ad hoc (proa:propose), or add an accepted manual one (humans)',
    description:
      '`kind: "propose"`: up to 200 items, each answered `applied`, `duplicate`, `suppressed`, ' +
      '`reopened` or `invalid:<reason>`; the server computes the tier. `kind: "manual"`: a human ' +
      'accepts a process on a step at once (agents get `human-decision-required`).',
    request: { params: chainParams, body: jsonBody(PostPlacementsBody) },
    responses: {
      200: json(PostPlacementsResult, 'The outcome'),
      ...problems(...READ_PROBLEMS, 'human-decision-required', 'forbidden'),
    },
  },
  decidePlacements: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements/decisions`,
    operationId: 'decidePlacements',
    tags: ['value-chains'],
    summary: 'Bulk decision on placements with ids, versions and expectedCount (all or nothing)',
    request: { params: chainParams, body: jsonBody(BulkPlacementDecisionBody) },
    responses: {
      200: json(BulkPlacementDecisionResult, 'The decided placements'),
      ...problems(...READ_PROBLEMS, ...REVIEW_PROBLEMS),
    },
  },
  getPlacement: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements/{placement}`,
    operationId: 'getPlacement',
    tags: ['value-chains'],
    summary: 'One placement (ETag `"<version>"`)',
    request: { params: placementParams },
    responses: {
      200: { ...json(Placement, 'The placement'), headers: VERSION_ETAG },
      ...problems(...READ_PROBLEMS),
    },
  },
  withdrawPlacementProposal: {
    method: 'delete',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements/{placement}/proposal`,
    operationId: 'withdrawPlacementProposal',
    tags: ['value-chains'],
    summary: "Withdraw the caller's own live proposal of a placement",
    request: { params: placementParams },
    responses: {
      200: json(Placement, 'The placement after the withdrawal'),
      ...problems(...READ_PROBLEMS, 'forbidden', 'conflict'),
    },
  },
  decidePlacement: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements/{placement}/decision`,
    operationId: 'decidePlacement',
    tags: ['value-chains'],
    summary: 'Decide a placement: accept, reject, hold or correct (humans only)',
    description:
      'Agents get 403 `human-decision-required` with `reviewUrl`. `If-Match: "<version>"` (or ' +
      '`version` in the body) makes the decision conditional: 412 `precondition-failed` (409 ' +
      '`conflict` for the body field) if the placement changed. A placement on a removed step ' +
      'can only be rejected or corrected (422 `unknown-step`).',
    request: {
      params: placementParams,
      headers: z.object({ 'if-match': z.string().max(100).optional() }),
      body: jsonBody(PlacementDecisionBody),
    },
    responses: {
      200: { ...json(PlacementDecisionResult, 'The decided placement'), headers: VERSION_ETAG },
      ...problems(...READ_PROBLEMS, ...REVIEW_PROBLEMS, 'precondition-failed'),
    },
  },
  addPlacementNote: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements/{placement}/notes`,
    operationId: 'addPlacementNote',
    tags: ['value-chains'],
    summary: 'Add a note to a placement, e.g. the answer to a held question (humans only)',
    request: { params: placementParams, body: jsonBody(NoteBody) },
    responses: {
      201: json(PlacementAssertion, 'The note'),
      ...problems(...READ_PROBLEMS, ...REVIEW_PROBLEMS),
    },
  },
  getPlacementAssertions: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/value-chains/{key}/placements/{placement}/assertions`,
    operationId: 'getPlacementAssertions',
    tags: ['value-chains'],
    summary: 'The history (timeline) of a placement: every assertion, oldest first',
    request: { params: placementParams },
    responses: {
      200: json(PlacementAssertionList, 'The assertions'),
      ...problems(...READ_PROBLEMS),
    },
  },

  claimAnalyses: {
    method: 'post',
    path: `${API_PREFIX}/analyses/claim`,
    operationId: 'claimAnalyses',
    tags: ['analyses'],
    summary: 'Claim up to 5 queued analysis tasks (15-minute lease, proa:propose)',
    description:
      'Claims queued tasks (and tasks whose lease expired with attempts left), oldest first, in ' +
      'the projects where the caller may propose (`projectId` narrows it), of the kinds the ' +
      'caller handles (`kinds`, default `["relations"]`), with `FOR UPDATE SKIP LOCKED`. Each ' +
      'item carries its `kind`, a lease token (shown once, bound to the task and the caller) and ' +
      'the compact claim input, rendered in the claim transaction. A `relations` item: the ' +
      'current agent judgements on pairs touching the model (`judged`) and the pairs a partner ' +
      'analysis judges (`skip`), both left out of `candidates`; the remaining `rule`, `key` and ' +
      '`lexical` candidates and the relations in neither list, accepted pairs, unchanged ' +
      'rejections and missing ends aside, are the task’s assignment, and the other ' +
      '`compatible` candidates the search space for missing partners. A `placement` item ' +
      '(`proa-claim-placement/1`): the chain’s steps, the open processes whose input changed ' +
      'since an agent last judged them (at most 50, `truncated` when more are due) with their ' +
      'proposals and the human decisions, and accepted placements as examples. ' +
      'Empty when nothing is claimable.',
    request: { body: jsonBody(ClaimAnalysisBody) },
    responses: {
      200: json(ClaimResult, 'The claimed tasks'),
      ...problems(...READ_PROBLEMS, 'forbidden'),
    },
  },
  getPendingAnalyses: {
    method: 'get',
    path: `${API_PREFIX}/analyses/pending`,
    operationId: 'getPendingAnalyses',
    tags: ['analyses'],
    summary: 'Claimable tasks per project; `wait=1..30` long-polls until work arrives',
    request: { query: PendingQuery },
    responses: {
      200: json(PendingAnalyses, 'Claimable tasks'),
      ...problems(...READ_PROBLEMS, 'forbidden'),
    },
  },
  submitAnalysis: {
    method: 'post',
    path: `${API_PREFIX}/analyses/{analysis}/submission`,
    operationId: 'submitAnalysis',
    tags: ['analyses'],
    summary: 'Submit the result of a claimed task (idempotent by submissionId)',
    description:
      'A `relations` task: validates every item (refs in the head facts, one endpoint in the ' +
      'task model, endpoint kinds, limits) and answers per relation `applied`, `duplicate`, ' +
      '`suppressed`, `reopened` or `invalid:<reason>`, per no-link `stored`, `duplicate` or ' +
      '`invalid:<reason>`, and the assigned pairs left unjudged (`uncovered`). Earlier pipeline ' +
      'proposals and no-links on pairs touching the model that were judged on another version of ' +
      'the model or under another procedure are withdrawn; current judgements stay. A ' +
      '`placement` task (`kind: "placement"` in the result): per placement and unsure item an ' +
      'outcome, the withdrawn stale or replaced pipeline proposals, the input processes left ' +
      'without a verdict (`skipped`) and whether a follow-up task was queued. 422 ' +
      '`wrong-task-kind` (items of the other kind); 409 `lease-lost` (another holder, a ' +
      'release, a wrong token), `task-cancelled` (new revision), `already-submitted` (another ' +
      'submissionId).',
    request: { params: analysisParams, body: jsonBody(SubmitAnalysisBody) },
    responses: {
      200: json(AnalysisSubmissionResult, 'The outcome per item'),
      ...problems(
        ...READ_PROBLEMS,
        'forbidden',
        'payload-too-large',
        'wrong-task-kind',
        ...LEASE_PROBLEMS,
      ),
    },
  },
  releaseAnalysis: {
    method: 'post',
    path: `${API_PREFIX}/analyses/{analysis}/release`,
    operationId: 'releaseAnalysis',
    tags: ['analyses'],
    summary: 'Hand a claimed task back; it is queued again',
    request: { params: analysisParams, body: jsonBody(ReleaseAnalysisBody) },
    responses: {
      200: json(ReleaseResult, 'The task is queued again'),
      ...problems(...READ_PROBLEMS, 'forbidden', ...LEASE_PROBLEMS),
    },
  },
  listAnalyses: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/analyses`,
    operationId: 'listAnalyses',
    tags: ['analyses'],
    summary: 'Analysis tasks of a project, newest first',
    request: { params: projectParams, query: AnalysisQuery },
    responses: { 200: json(AnalysisTaskPage, 'A page of tasks'), ...problems(...READ_PROBLEMS) },
  },
  requeueAnalyses: {
    method: 'post',
    path: `${API_PREFIX}/projects/{project}/analyses/requeue`,
    operationId: 'requeueAnalyses',
    tags: ['analyses'],
    summary:
      'Queue models again, e.g. after a procedure upgrade, or the value chain placement task (proa:write)',
    request: { params: projectParams, body: jsonBody(RequeueBody) },
    responses: {
      200: json(RequeueResult, 'Outcome per model'),
      ...problems(...READ_PROBLEMS, 'forbidden'),
    },
  },
  getAnalysisSubmission: {
    method: 'get',
    path: `${API_PREFIX}/projects/{project}/analyses/{analysis}/submission`,
    operationId: 'getAnalysisSubmission',
    tags: ['analyses'],
    summary: 'The stored submission of a done task: verbatim payload and result',
    request: { params: projectAnalysisParams },
    responses: {
      200: json(AnalysisSubmission, 'The submission'),
      ...problems(...READ_PROBLEMS),
    },
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
