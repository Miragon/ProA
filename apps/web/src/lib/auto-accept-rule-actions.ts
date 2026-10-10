import {
  applyAutoAcceptRule,
  createAutoAcceptRule,
  reviseAutoAcceptRule,
  type ApplyAutoAcceptResult,
  type AutoAcceptRuleDraft,
  type SaveAutoAcceptRuleResult,
} from '@proa/client';
import { useMutation } from '@tanstack/react-query';

import { api, unwrap } from './api';
import { useInvalidateProject } from './auto-accept-actions';

/**
 * Auto-accept rule writes of the tab „Regeln“ (owner decision 19): create,
 * edit, enable and disable (each a new revision; edits with `If-Match`),
 * and apply a rule to the open proposals (a dry run first, then with the
 * head revision and its count).
 */

export function useCreateRule(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: (draft: AutoAcceptRuleDraft): Promise<SaveAutoAcceptRuleResult> =>
      unwrap(createAutoAcceptRule({ client: api, path: { project }, body: draft })),
    onSettled: invalidate,
  });
}

export interface ReviseInput {
  ruleId: string;
  /** The head revision the owner edited (`If-Match: "r<revision>"`). */
  revision: number;
  draft: AutoAcceptRuleDraft;
}

export function useReviseRule(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({ ruleId, revision, draft }: ReviseInput): Promise<SaveAutoAcceptRuleResult> =>
      unwrap(
        reviseAutoAcceptRule({
          client: api,
          path: { project, rule: ruleId },
          headers: { 'if-match': `"r${revision}"` },
          body: draft,
        }),
      ),
    onSettled: invalidate,
  });
}

export interface ApplyInput {
  ruleId: string;
  dryRun: boolean;
  revision?: number;
  expectedCount?: number;
}

export function useApplyRule(project: string) {
  const invalidate = useInvalidateProject(project);
  return useMutation({
    mutationFn: ({
      ruleId,
      dryRun,
      revision,
      expectedCount,
    }: ApplyInput): Promise<ApplyAutoAcceptResult> =>
      unwrap(
        applyAutoAcceptRule({
          client: api,
          path: { project, rule: ruleId },
          ...(dryRun ? { query: { dryRun: 'true' as const } } : {}),
          body: dryRun ? {} : { revision, expectedCount },
        }),
      ),
    onSettled: (_data, _error, input) => (input.dryRun ? undefined : invalidate()),
  });
}
