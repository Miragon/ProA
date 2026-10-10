import {
  getHealth,
  getLandscape,
  getPlacementAssertions,
  getProject,
  getRelation,
  getRelationAssertions,
  getRevisionContent,
  getRevisionFacts,
  getValueChain,
  getValueChainContent,
  getValueChainStep,
  listAgentTokens,
  listAnalyses,
  listAutoAcceptRules,
  listAutoAccepted,
  listModels,
  listNoLinks,
  listPlacements,
  listProjects,
  listUnplacedProcesses,
  listValueChainRevisions,
  revokeAutoAccepted,
  type Health,
} from '@proa/client';
import type {
  AgentToken,
  AnalysisTask,
  AnalysisTaskState,
  AutoAcceptRevocationBody,
  AutoAcceptRevocationResult,
  AutoAcceptLedgerEntry,
  AutoAcceptRuleList,
  Landscape,
  Model,
  NoLink,
  Placement,
  PlacementAssertion,
  Project,
  Relation,
  RelationAssertion,
  RevisionFacts,
  UnplacedProcess,
  ValueChainDetail,
  ValueChainRevision,
  ValueChainStepDetail,
} from '@proa/client';
import { queryOptions } from '@tanstack/react-query';

import { api, unwrap, unwrapWithResponse } from './api';
import { MAX_PAGE_LIMIT, VALUE_CHAIN_KEY } from './limits';
import { revisionOfEtag } from './value-chain';

/**
 * Query keys and fetchers. Everything below `['project', key]` belongs to one
 * project and is invalidated together after an import.
 */
export const keys = {
  health: ['health'] as const,
  projects: ['projects'] as const,
  project: (project: string) => ['project', project] as const,
  models: (project: string) => ['project', project, 'models'] as const,
  landscape: (project: string) => ['project', project, 'landscape'] as const,
  noLinks: (project: string) => ['project', project, 'no-links'] as const,
  agentTokens: (project: string) => ['project', project, 'agent-tokens'] as const,
  relation: (project: string, id: string) => ['project', project, 'relation', id] as const,
  assertions: (project: string, id: string) =>
    ['project', project, 'relation', id, 'assertions'] as const,
  analyses: (project: string, state: AnalysisTaskState) =>
    ['project', project, 'analyses', state] as const,
  // The value chain (M4): under the project, so every project invalidation refreshes it.
  valueChain: (project: string) => ['project', project, 'value-chain', 'detail'] as const,
  valueChainContent: (project: string) => ['project', project, 'value-chain', 'content'] as const,
  placements: (project: string) => ['project', project, 'value-chain', 'placements'] as const,
  placementAssertions: (project: string, id: string) =>
    ['project', project, 'value-chain', 'placement', id, 'assertions'] as const,
  valueChainStep: (project: string, elementId: string) =>
    ['project', project, 'value-chain', 'step', elementId] as const,
  unplaced: (project: string) => ['project', project, 'value-chain', 'unplaced'] as const,
  chainRevisions: (project: string) => ['project', project, 'value-chain', 'revisions'] as const,
  // Auto-accept rules (owner decision 19): the rules owner only, the ledger every reviewer.
  autoAcceptRules: (project: string) => ['project', project, 'auto-accept', 'rules'] as const,
  autoAcceptRule: (project: string, id: string) =>
    ['project', project, 'auto-accept', 'rule', id] as const,
  autoAccepted: (project: string) => ['project', project, 'auto-accept', 'ledger'] as const,
  autoAcceptPreview: (project: string, criteria: object) =>
    ['project', project, 'auto-accept', 'preview', criteria] as const,
  autoAcceptApplyDryRun: (project: string, ruleId: string, revision: number) =>
    ['project', project, 'auto-accept', 'apply-dry-run', ruleId, revision] as const,
  autoAcceptRevokeDryRun: (project: string, selection: AutoAcceptRevocationBody) =>
    ['project', project, 'auto-accept', 'revoke-dry-run', selection] as const,
  // Revisions are immutable: keyed by revision id, cached for good.
  facts: (revisionId: string) => ['revision', revisionId, 'facts'] as const,
  content: (revisionId: string) => ['revision', revisionId, 'content'] as const,
};

export const healthQuery = queryOptions({
  queryKey: keys.health,
  queryFn: async (): Promise<Health> => {
    const { data, error } = await getHealth({ client: api });
    if (data) return data;
    // 503 still carries a Health body; network failures carry none.
    if (error != null && typeof error === 'object' && 'db' in error) return error;
    throw new Error('ProA-Server nicht erreichbar');
  },
  refetchInterval: 30_000,
});

/** Follows `nextCursor` until the list is complete (M1 projects stay small). */
async function allPages<T>(
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor: string | null }>,
): Promise<T[]> {
  const items: T[] = [];
  let cursor: string | undefined;
  for (;;) {
    const result = await page(cursor);
    items.push(...result.items);
    if (result.nextCursor === null) return items;
    cursor = result.nextCursor;
  }
}

export const projectsQuery = queryOptions({
  queryKey: keys.projects,
  queryFn: (): Promise<Project[]> =>
    allPages((cursor) =>
      unwrap(listProjects({ client: api, query: { limit: MAX_PAGE_LIMIT, cursor } })),
    ),
});

export const projectQuery = (project: string) =>
  queryOptions({
    queryKey: keys.project(project),
    queryFn: (): Promise<Project> => unwrap(getProject({ client: api, path: { project } })),
  });

export const modelsQuery = (project: string) =>
  queryOptions({
    queryKey: keys.models(project),
    queryFn: (): Promise<Model[]> =>
      allPages((cursor) =>
        unwrap(
          listModels({ client: api, path: { project }, query: { limit: MAX_PAGE_LIMIT, cursor } }),
        ),
      ),
  });

export const landscapeQuery = (project: string) =>
  queryOptions({
    queryKey: keys.landscape(project),
    queryFn: (): Promise<Landscape> => unwrap(getLandscape({ client: api, path: { project } })),
  });

/** Agents' live, current no-links, also on pairs without a relation (oldest first). */
export const noLinksQuery = (project: string) =>
  queryOptions({
    queryKey: keys.noLinks(project),
    queryFn: async (): Promise<NoLink[]> =>
      (await unwrap(listNoLinks({ client: api, path: { project } }))).items,
  });

/** One relation, also an obsolete one (the landscape leaves those out). */
export const relationQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: keys.relation(project, id),
    queryFn: (): Promise<Relation> =>
      unwrap(getRelation({ client: api, path: { project, relation: id } })),
  });

/** The relation's history, oldest first. */
export const assertionsQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: keys.assertions(project, id),
    queryFn: async (): Promise<RelationAssertion[]> =>
      (await unwrap(getRelationAssertions({ client: api, path: { project, relation: id } }))).items,
  });

/**
 * Relations tasks in one state, newest first (who works on what, why a task
 * failed); the value chain's placement task shows on the chain page.
 */
export const analysesQuery = (project: string, state: AnalysisTaskState) =>
  queryOptions({
    queryKey: keys.analyses(project, state),
    queryFn: (): Promise<AnalysisTask[]> =>
      allPages((cursor) =>
        unwrap(
          listAnalyses({
            client: api,
            path: { project },
            query: { state, kind: 'relations', limit: MAX_PAGE_LIMIT, cursor },
          }),
        ),
      ),
  });

export const agentTokensQuery = (project: string) =>
  queryOptions({
    queryKey: keys.agentTokens(project),
    queryFn: async (): Promise<AgentToken[]> =>
      (await unwrap(listAgentTokens({ client: api, path: { project } }))).items,
  });

interface RevisionRef {
  project: string;
  modelId: string;
  revisionId: string;
}

export const factsQuery = ({ project, modelId, revisionId }: RevisionRef) =>
  queryOptions({
    queryKey: keys.facts(revisionId),
    queryFn: (): Promise<RevisionFacts> =>
      unwrap(
        getRevisionFacts({
          client: api,
          path: { project, model: modelId, revision: revisionId },
        }),
      ),
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

export interface RevisionContent {
  xml: string;
}

export const contentQuery = ({ project, modelId, revisionId }: RevisionRef) =>
  queryOptions({
    queryKey: keys.content(revisionId),
    queryFn: async (): Promise<RevisionContent> => {
      const body = await unwrap(
        getRevisionContent({
          client: api,
          path: { project, model: modelId, revision: revisionId },
          parseAs: 'text',
        }),
      );
      const xml = typeof body === 'string' ? body : await new Response(body as Blob).text();
      return { xml };
    },
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });

// ----------------------------------------------------------- value chain (M4)

const chain = (project: string) => ({ project, key: VALUE_CHAIN_KEY });

/** The chain with steps, placements (summaries) and findings; 404 while there is none. */
export const valueChainQuery = (project: string) =>
  queryOptions({
    queryKey: keys.valueChain(project),
    queryFn: (): Promise<ValueChainDetail> =>
      unwrap(getValueChain({ client: api, path: chain(project) })),
  });

export interface ValueChainContent {
  /** The canonical `.vc.json` bytes as text. */
  text: string;
  /** The head revision, from `ETag: "r<rev>"`. */
  rev: number;
}

/** The head document (canonical text) and its revision. */
export const valueChainContentQuery = (project: string) =>
  queryOptions({
    queryKey: keys.valueChainContent(project),
    queryFn: async (): Promise<ValueChainContent> => {
      const { data, response } = await unwrapWithResponse(
        getValueChainContent({ client: api, path: chain(project), parseAs: 'text' }),
      );
      const text =
        typeof data === 'string' ? data : await new Response(data as unknown as Blob).text();
      const rev = revisionOfEtag(response.headers.get('etag'));
      if (rev === null) throw new Error('Der Server hat die Kette ohne Revision geschickt.');
      return { text, rev };
    },
  });

/** Every non-obsolete placement with provenance (the cards). */
export const placementsQuery = (project: string) =>
  queryOptions({
    queryKey: keys.placements(project),
    queryFn: (): Promise<Placement[]> =>
      allPages((cursor) =>
        unwrap(
          listPlacements({
            client: api,
            path: chain(project),
            query: { limit: MAX_PAGE_LIMIT, cursor },
          }),
        ),
      ),
  });

/** A placement's history, oldest first. */
export const placementAssertionsQuery = (project: string, id: string) =>
  queryOptions({
    queryKey: keys.placementAssertions(project, id),
    queryFn: async (): Promise<PlacementAssertion[]> =>
      (
        await unwrap(
          getPlacementAssertions({ client: api, path: { ...chain(project), placement: id } }),
        )
      ).items,
  });

/** The drill-down of one step (404 for a step that is not in the head). */
export const valueChainStepQuery = (project: string, elementId: string) =>
  queryOptions({
    queryKey: keys.valueChainStep(project, elementId),
    queryFn: (): Promise<ValueChainStepDetail> =>
      unwrap(getValueChainStep({ client: api, path: { ...chain(project), elementId } })),
  });

/** Processes without a home step and without a placement waiting for review. */
export const unplacedQuery = (project: string) =>
  queryOptions({
    queryKey: keys.unplaced(project),
    queryFn: (): Promise<UnplacedProcess[]> =>
      allPages((cursor) =>
        unwrap(
          listUnplacedProcesses({
            client: api,
            path: chain(project),
            query: { limit: MAX_PAGE_LIMIT, cursor },
          }),
        ),
      ),
  });

/** The newest revision (who saved the head, when); `null` without one. */
export const chainRevisionQuery = (project: string) =>
  queryOptions({
    queryKey: keys.chainRevisions(project),
    queryFn: async (): Promise<ValueChainRevision | null> =>
      (
        await unwrap(
          listValueChainRevisions({ client: api, path: chain(project), query: { limit: 1 } }),
        )
      ).items[0] ?? null,
  });

// ------------------------------------------------- auto-accept rules (decision 19)

/** The project's auto-accept rules (creation order) and the system rule; owners only. */
export const autoAcceptRulesQuery = (project: string) =>
  queryOptions({
    queryKey: keys.autoAcceptRules(project),
    queryFn: (): Promise<AutoAcceptRuleList> =>
      unwrap(listAutoAcceptRules({ client: api, path: { project } })),
  });

/**
 * The auto-accept ledger (every acceptance a rule recorded and its state):
 * the review views join it to mark items, since relations and placements
 * carry no marker of their own. Every reviewer (editors and owners).
 */
export const autoAcceptedQuery = (project: string) =>
  queryOptions({
    queryKey: keys.autoAccepted(project),
    queryFn: async (): Promise<AutoAcceptLedgerEntry[]> =>
      (await unwrap(listAutoAccepted({ client: api, path: { project } }))).items,
  });

/** The dry run of a revocation (never cached). */
export const autoAcceptRevokeDryRunQuery = (project: string, selection: AutoAcceptRevocationBody) =>
  queryOptions({
    queryKey: keys.autoAcceptRevokeDryRun(project, selection),
    queryFn: (): Promise<AutoAcceptRevocationResult> =>
      unwrap(
        revokeAutoAccepted({
          client: api,
          path: { project },
          query: { dryRun: 'true' },
          body: selection,
        }),
      ),
    staleTime: 0,
    gcTime: 0,
  });
