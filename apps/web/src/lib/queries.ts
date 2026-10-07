import {
  getHealth,
  getLandscape,
  getProject,
  getRevisionContent,
  getRevisionFacts,
  listAgentTokens,
  listModels,
  listProjects,
  type Health,
} from '@proa/client';
import type { AgentToken, Landscape, Model, Project, RevisionFacts } from '@proa/client';
import { queryOptions } from '@tanstack/react-query';

import { api, unwrap } from './api';
import { detectEngine, type Engine } from './engine';
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
  engine: Engine | null;
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
      return { xml, engine: detectEngine(xml) };
    },
    staleTime: Infinity,
    gcTime: 30 * 60_000,
  });
