import {
  getHealth,
  getLandscape,
  getProject,
  getRelation,
  getRelationAssertions,
  getRevisionContent,
  getRevisionFacts,
  listAgentTokens,
  listAnalyses,
  listModels,
  listProjects,
  type Health,
} from '@proa/client';
import type {
  AgentToken,
  AnalysisTask,
  AnalysisTaskState,
  Landscape,
  Model,
  Project,
  Relation,
  RelationAssertion,
  RevisionFacts,
} from '@proa/client';
import { queryOptions } from '@tanstack/react-query';

import { api, unwrap } from './api';
import { MAX_PAGE_LIMIT } from './limits';

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
  agentTokens: (project: string) => ['project', project, 'agent-tokens'] as const,
  relation: (project: string, id: string) => ['project', project, 'relation', id] as const,
  assertions: (project: string, id: string) =>
    ['project', project, 'relation', id, 'assertions'] as const,
  analyses: (project: string, state: AnalysisTaskState) =>
    ['project', project, 'analyses', state] as const,
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

/** Analysis tasks in one state, newest first (who works on what, why a task failed). */
export const analysesQuery = (project: string, state: AnalysisTaskState) =>
  queryOptions({
    queryKey: keys.analyses(project, state),
    queryFn: (): Promise<AnalysisTask[]> =>
      allPages((cursor) =>
        unwrap(
          listAnalyses({
            client: api,
            path: { project },
            query: { state, limit: MAX_PAGE_LIMIT, cursor },
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
