import {
  revokeAutoAccepted,
  type AutoAcceptRevocationBody,
  type AutoAcceptRevocationResult,
} from '@proa/client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';

import { api, unwrap } from './api';
import { EMPTY_AUTO_ACCEPT_INDEX, indexLedger, type AutoAcceptIndex } from './auto-accept';
import { useProjectPermissions } from './permissions';
import { autoAcceptedQuery, keys } from './queries';

/**
 * Auto-accept marks and revocations (owner decision 19): who may see rules
 * (owners) and the marks (every reviewer), the ledger as an index for the
 * review views, and revoking acceptances (owners; a dry run first, then with
 * its count). A real write refreshes everything of the project afterwards,
 * also after a failure (a conflict means the cache is stale); a dry run is a
 * read and refreshes nothing. Rule writes are in `auto-accept-rule-actions.ts`
 * (the tab „Regeln“).
 */

export function useInvalidateProject(project: string) {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: keys.project(project) });
}

/**
 * Whether the caller owns the project: only owners see and maintain
 * auto-accept rules and revoke acceptances (never on the read-only demo).
 */
export function useIsOwner(project: string): boolean {
  return useProjectPermissions(project).isOwner;
}

/** Whether the caller reviews in the project (editor or owner): they see the marks. */
export function useCanReview(project: string): boolean {
  return useProjectPermissions(project).canReview;
}

/**
 * The auto-accept ledger as an index for the marks (every reviewer, so a
 * machine acceptance never passes for a human one; for viewers, and while it
 * loads, an empty index).
 */
export function useAutoAcceptIndex(project: string): AutoAcceptIndex {
  const reviewer = useCanReview(project);
  const ledger = useQuery({ ...autoAcceptedQuery(project), enabled: reviewer });
  return useMemo(
    () => (ledger.data ? indexLedger(ledger.data) : EMPTY_AUTO_ACCEPT_INDEX),
    [ledger.data],
  );
}

export interface RevokeInput {
  body: AutoAcceptRevocationBody;
  dryRun: boolean;
}

export function useRevokeAutoAccepted(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({ body, dryRun }: RevokeInput): Promise<AutoAcceptRevocationResult> =>
      unwrap(
        revokeAutoAccepted({
          client: api,
          path: { project },
          ...(dryRun ? { query: { dryRun: 'true' as const } } : {}),
          body,
        }),
      ),
    onSettled: (_data, _error, input) => (input.dryRun ? undefined : invalidate()),
  });
}
