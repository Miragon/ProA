import {
  addRelationNote,
  decideRelation,
  decideRelations,
  requeueAnalyses,
  type BulkDecisionBody,
  type BulkDecisionResult,
  type DecisionBody,
  type DecisionResult,
  type RelationAssertion,
  type RequeueResult,
} from '@proa/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from './api';
import { keys } from './queries';

/**
 * Review writes (CONCEPT §3): one decision, a bulk decision, a note (answer
 * to a held question), a requeue. Each refreshes everything of the project
 * afterwards, also after a failure (a conflict means the cache is stale).
 */

function useInvalidateProject(project: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.project(project) });
}

export interface DecideInput {
  relationId: string;
  body: DecisionBody;
}

export function useDecide(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({ relationId, body }: DecideInput): Promise<DecisionResult> =>
      unwrap(decideRelation({ client: api, path: { project, relation: relationId }, body })),
    onSettled: invalidate,
  });
}

export function useBulkDecide(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: (body: BulkDecisionBody): Promise<BulkDecisionResult> =>
      unwrap(decideRelations({ client: api, path: { project }, body })),
    onSettled: invalidate,
  });
}

export function useAddNote(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({
      relationId,
      text,
    }: {
      relationId: string;
      text: string;
    }): Promise<RelationAssertion> =>
      unwrap(
        addRelationNote({ client: api, path: { project, relation: relationId }, body: { text } }),
      ),
    onSettled: invalidate,
  });
}

export function useRequeue(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: (modelKeys: string[]): Promise<RequeueResult> =>
      unwrap(requeueAnalyses({ client: api, path: { project }, body: { modelKeys } })),
    onSettled: invalidate,
  });
}

/** The value chain's placement task (M4 §3.2): queued when an open process is due. */
export function useRequeueChain(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: (): Promise<RequeueResult> =>
      unwrap(requeueAnalyses({ client: api, path: { project }, body: { valueChain: true } })),
    onSettled: invalidate,
  });
}
