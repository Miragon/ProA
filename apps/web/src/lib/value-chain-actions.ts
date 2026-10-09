import {
  addPlacementNote,
  decidePlacement,
  decidePlacements,
  postPlacements,
  type BulkPlacementDecisionBody,
  type BulkPlacementDecisionResult,
  type ManualPlacementResult,
  type PlacementAssertion,
  type PlacementDecisionBody,
  type PlacementDecisionResult,
} from '@proa/client';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { api, unwrap } from './api';
import { VALUE_CHAIN_KEY } from './limits';
import { keys } from './queries';

/**
 * Placement writes of the value chain page (M4 §4): a decision, the bulk
 * re-confirm, a manual placement ("Prozess hinzufügen", "Platzieren") and a
 * note (the answer to a held question). Each refreshes everything of the
 * project afterwards, also after a failure (a conflict means the cache is
 * stale).
 */

function useInvalidateProject(project: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.project(project) });
}

const chain = (project: string) => ({ project, key: VALUE_CHAIN_KEY });

export interface DecidePlacementInput {
  placementId: string;
  body: PlacementDecisionBody;
}

export function useDecidePlacement(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({ placementId, body }: DecidePlacementInput): Promise<PlacementDecisionResult> =>
      unwrap(
        decidePlacement({ client: api, path: { ...chain(project), placement: placementId }, body }),
      ),
    onSettled: invalidate,
  });
}

export function useBulkDecidePlacements(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: (body: BulkPlacementDecisionBody): Promise<BulkPlacementDecisionResult> =>
      unwrap(decidePlacements({ client: api, path: chain(project), body })),
    onSettled: invalidate,
  });
}

export interface ManualPlacementInput {
  step: string;
  process: string;
  rationale: string;
}

export function useManualPlacement(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: async ({
      step,
      process,
      rationale,
    }: ManualPlacementInput): Promise<ManualPlacementResult> => {
      const result = await unwrap(
        postPlacements({
          client: api,
          path: chain(project),
          body: { kind: 'manual', step, process, rationale },
        }),
      );
      if (result.kind !== 'manual') throw new Error('Unerwartete Antwort des Servers.');
      return result;
    },
    onSettled: invalidate,
  });
}

export function useAddPlacementNote(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({
      placementId,
      text,
    }: {
      placementId: string;
      text: string;
    }): Promise<PlacementAssertion> =>
      unwrap(
        addPlacementNote({
          client: api,
          path: { ...chain(project), placement: placementId },
          body: { text },
        }),
      ),
    onSettled: invalidate,
  });
}
