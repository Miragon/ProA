import type { Model, RevisionFacts } from '@proa/client';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';

import { factsQuery } from './queries';
import { bareResolver, buildRefIndex, resolverOf, type RefResolver } from './refs';

export interface ProjectFacts {
  /** Labels for refs; knows only the ref itself until the facts are loaded. */
  resolve: RefResolver;
  /** Facts per model key (head revisions), as far as loaded. */
  byModel: ReadonlyMap<string, RevisionFacts>;
  loading: boolean;
}

/** Stable `combine`: TanStack Query re-runs it only when a result changes. */
function combine(results: UseQueryResult<RevisionFacts>[]) {
  return {
    facts: results.flatMap((r) => (r.data ? [r.data] : [])),
    pending: results.some((r) => r.isPending),
  };
}

/**
 * Facts of every head revision of a project, for element labels in tables.
 * Revisions are immutable, so each is fetched once per session.
 */
export function useProjectFacts(
  project: string,
  models: readonly Model[] | undefined,
): ProjectFacts {
  const { facts, pending } = useQueries({
    queries: (models ?? []).map((m) =>
      factsQuery({ project, modelId: m.id, revisionId: m.headRevisionId }),
    ),
    combine,
  });
  const loading = models === undefined || pending;
  return useMemo(() => {
    const byModel = new Map(facts.map((f) => [f.modelKey, f]));
    if (byModel.size === 0) return { resolve: bareResolver, byModel, loading };
    const index = buildRefIndex(
      facts.flatMap((f) => f.facts),
      facts.flatMap((f) => f.processes),
    );
    return { resolve: resolverOf(index), byModel, loading };
  }, [facts, loading]);
}
